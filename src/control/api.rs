//! JSON API used by the web UI.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::middleware::from_fn_with_state;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;

use super::auth::{self, Session, clean_name};
use super::db::{AgentRow, now};
use super::machines::LOCAL_ID;
use super::webauthn::{b64, unb64};
use super::{App, snippets};
use crate::model::valid_container_ref;

pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
        }
    }
    pub fn bad_request(e: impl std::fmt::Display) -> Self {
        Self::new(StatusCode::BAD_REQUEST, e.to_string())
    }
    pub fn internal(e: impl std::fmt::Display) -> Self {
        tracing::error!("internal error: {e}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
    fn not_found(what: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, format!("{what} not found"))
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!("internal error: {e:#}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

pub fn router(app: App) -> Router {
    let public = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/auth/status", get(auth::status))
        .route("/auth/login/begin", post(auth::login_begin))
        .route("/auth/login/finish", post(auth::login_finish))
        .route("/auth/register/begin", post(auth::register_begin))
        .route("/auth/register/finish", post(auth::register_finish))
        .route("/auth/logout", post(auth::logout))
        .route_layer(from_fn_with_state(app.clone(), auth::check_origin));

    let private = Router::new()
        .route("/machines", get(machines))
        .route("/machines/refresh", post(refresh))
        .route("/logs", get(logs))
        .route("/agents", get(list_agents).post(create_agent))
        .route("/agents/{id}", patch(update_agent).delete(delete_agent))
        .route("/agents/{id}/reissue", post(reissue_agent))
        .route("/passkeys", get(list_passkeys))
        .route(
            "/passkeys/{id}",
            patch(rename_passkey).delete(delete_passkey),
        )
        .route("/invites", post(create_invite))
        .route("/system", get(system))
        .route_layer(from_fn_with_state(app.clone(), auth::require_session));

    public.merge(private).with_state(app)
}

// ---- machines & logs ----

async fn machines(State(app): State<App>) -> ApiResult<impl IntoResponse> {
    Ok(Json(app.registry.views().await))
}

async fn refresh(State(app): State<App>) -> ApiResult<impl IntoResponse> {
    app.registry.poll_all().await;
    Ok(Json(app.registry.views().await))
}

#[derive(Deserialize)]
struct LogsQuery {
    machine: String,
    containers: String,
    tail: Option<u32>,
    /// Unix microseconds: resume after this time instead of sending the tail.
    since: Option<i64>,
}

async fn logs(State(app): State<App>, Query(q): Query<LogsQuery>) -> ApiResult<impl IntoResponse> {
    let machine = app
        .registry
        .get(&q.machine)
        .await
        .ok_or_else(|| ApiError::not_found("machine"))?;
    let ids: Vec<String> = q
        .containers
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    if ids.is_empty() || ids.len() > 64 || ids.iter().any(|i| !valid_container_ref(i)) {
        return Err(ApiError::bad_request("invalid container list"));
    }
    let tail = q.tail.unwrap_or(500).min(20_000);
    let events = machine.logs(ids, tail, q.since);
    // Batch lines so busy containers don't produce one SSE event per line.
    let batches = tokio_stream::StreamExt::chunks_timeout(events, 500, Duration::from_millis(50));
    let stream = batches
        .map(|batch| {
            Ok::<_, Infallible>(
                Event::default()
                    .event("logs")
                    .json_data(batch)
                    .unwrap_or_default(),
            )
        })
        // Tell the browser not to reconnect (EventSource would replay the tail).
        .chain(futures_util::stream::once(async {
            Ok(Event::default().event("end").data("end"))
        }));
    let sse = Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)));
    // Stop nginx (and similar reverse proxies) from buffering the live stream.
    Ok((
        [("x-accel-buffering", "no"), ("cache-control", "no-cache")],
        sse,
    ))
}

// ---- agents ----

#[derive(Deserialize)]
struct AgentRequest {
    name: Option<String>,
    address: Option<String>,
    port: Option<u16>,
}

fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s: String = s.trim_matches('-').chars().take(40).collect();
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() { "agent".into() } else { s }
}

fn valid_address(a: &str) -> bool {
    !a.is_empty()
        && a.len() <= 253
        && a.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
}

async fn list_agents(State(app): State<App>) -> ApiResult<impl IntoResponse> {
    let mut out = Vec::new();
    for row in app.db.agents()? {
        let status = app.registry.status(&row.id).await;
        out.push(json!({ "agent": row, "status": status }));
    }
    Ok(Json(out))
}

async fn create_agent(
    State(app): State<App>,
    Json(req): Json<AgentRequest>,
) -> ApiResult<impl IntoResponse> {
    let name = clean_name(req.name.as_deref().unwrap_or_default(), "");
    if name.is_empty() {
        return Err(ApiError::bad_request("a name is required"));
    }
    let base = slug(&name);
    let mut id = base.clone();
    let mut n = 2;
    while id == LOCAL_ID || app.db.agent(&id)?.is_some() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let address = req
        .address
        .map(|a| a.trim().to_lowercase())
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| format!("driftwatch-{id}"));
    if !valid_address(&address) {
        return Err(ApiError::bad_request(
            "address must be a host name or IP address",
        ));
    }
    let issued = app.ca.issue_agent(&id)?;
    let row = AgentRow {
        id: id.clone(),
        name,
        address,
        port: req.port.unwrap_or(7443),
        fingerprint: issued.fingerprint.clone(),
        created_at: now(),
        cert_issued_at: now(),
    };
    app.db.insert_agent(&row)?;
    app.reload_machines().await?;
    tracing::info!("added agent '{}' ({})", row.name, row.id);
    let snippet = snippets::agent(&app.cfg.image, &row, &issued, &app.ca.cert_pem);
    Ok(Json(json!({ "agent": row, "snippet": snippet })))
}

async fn update_agent(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(req): Json<AgentRequest>,
) -> ApiResult<impl IntoResponse> {
    let row = app
        .db
        .agent(&id)?
        .ok_or_else(|| ApiError::not_found("agent"))?;
    let name = req
        .name
        .map(|n| clean_name(&n, &row.name))
        .unwrap_or(row.name);
    let address = req
        .address
        .map(|a| a.trim().to_lowercase())
        .unwrap_or(row.address);
    if !valid_address(&address) {
        return Err(ApiError::bad_request(
            "address must be a host name or IP address",
        ));
    }
    let port = req.port.unwrap_or(row.port);
    app.db.update_agent(&id, &name, &address, port)?;
    app.reload_machines().await?;
    Ok(Json(app.db.agent(&id)?))
}

async fn reissue_agent(
    State(app): State<App>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let row = app
        .db
        .agent(&id)?
        .ok_or_else(|| ApiError::not_found("agent"))?;
    let issued = app.ca.issue_agent(&id)?;
    app.db.set_agent_fingerprint(&id, &issued.fingerprint)?;
    app.reload_machines().await?;
    tracing::info!("reissued certificate for agent '{id}'");
    let row = app.db.agent(&id)?.unwrap_or(row);
    let snippet = snippets::agent(&app.cfg.image, &row, &issued, &app.ca.cert_pem);
    Ok(Json(json!({ "agent": row, "snippet": snippet })))
}

async fn delete_agent(
    State(app): State<App>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    if !app.db.delete_agent(&id)? {
        return Err(ApiError::not_found("agent"));
    }
    app.reload_machines().await?;
    tracing::info!("removed agent '{id}'");
    Ok(Json(json!({ "ok": true })))
}

// ---- passkeys & invites ----

async fn list_passkeys(
    State(app): State<App>,
    Extension(s): Extension<Session>,
) -> ApiResult<impl IntoResponse> {
    let list: Vec<_> = app
        .db
        .passkeys()?
        .into_iter()
        .map(|p| {
            json!({
                "id": b64(&p.id),
                "name": p.name,
                "createdAt": p.created_at,
                "lastUsedAt": p.last_used_at,
                "current": p.id == s.passkey_id,
            })
        })
        .collect();
    Ok(Json(list))
}

#[derive(Deserialize)]
struct RenameRequest {
    name: String,
}

async fn rename_passkey(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(req): Json<RenameRequest>,
) -> ApiResult<impl IntoResponse> {
    let id = unb64(&id).map_err(ApiError::bad_request)?;
    if !app
        .db
        .rename_passkey(&id, &clean_name(&req.name, "Passkey"))?
    {
        return Err(ApiError::not_found("passkey"));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn delete_passkey(
    State(app): State<App>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let id = unb64(&id).map_err(ApiError::bad_request)?;
    app.db
        .delete_passkey(&id)?
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, e))?;
    Ok(Json(json!({ "ok": true })))
}

async fn create_invite(State(app): State<App>) -> ApiResult<impl IntoResponse> {
    let (token, expires) = auth::create_invite(&app.db, 30 * 60)?;
    Ok(Json(
        json!({ "url": format!("{}/#/invite/{token}", app.rp.origin), "expiresAt": expires }),
    ))
}

async fn system(State(app): State<App>) -> ApiResult<impl IntoResponse> {
    Ok(Json(json!({
        "version": crate::VERSION,
        "publicUrl": app.rp.origin,
        "rpId": app.rp.id,
        "caFingerprint": app.ca.fingerprint()?,
        "localCollection": app.local.is_some(),
        "image": app.cfg.image,
        "controlSnippet": snippets::control(&app.cfg.image, &app.rp.id, &app.rp.origin),
    })))
}

#[cfg(test)]
mod tests {
    use super::slug;

    #[test]
    fn slugs() {
        assert_eq!(slug("My NAS (basement)"), "my-nas-basement");
        assert_eq!(slug("--"), "agent");
        assert_eq!(slug("Pi 4"), "pi-4");
    }
}
