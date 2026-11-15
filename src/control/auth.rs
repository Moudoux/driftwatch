//! Passkey sign-in, sessions and invites.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::Json;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::api::ApiError;
use super::db::Db;
use super::webauthn::{AssertionCredential, RegistrationCredential, b64, unb64};
use super::{App, AppState};

const SESSION_TTL: i64 = 30 * 24 * 3600;
const CHALLENGE_TTL: Duration = Duration::from_secs(300);
const MAX_PENDING: usize = 256;

enum Ceremony {
    Login,
    Register { invite_hash: Option<Vec<u8>> },
}

struct Pending {
    challenge: Vec<u8>,
    ceremony: Ceremony,
    expires: Instant,
}

#[derive(Default)]
pub struct Challenges(Mutex<HashMap<String, Pending>>);

impl Challenges {
    fn insert(&self, ceremony: Ceremony) -> Result<(String, Vec<u8>), ApiError> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        map.retain(|_, p| p.expires > now);
        if map.len() >= MAX_PENDING {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too many pending sign-in attempts",
            ));
        }
        let id = random_token();
        let challenge = random_bytes();
        map.insert(
            id.clone(),
            Pending {
                challenge: challenge.clone(),
                ceremony,
                expires: now + CHALLENGE_TTL,
            },
        );
        Ok((id, challenge))
    }

    fn take(&self, id: &str) -> Option<Pending> {
        let p = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)?;
        (p.expires > Instant::now()).then_some(p)
    }
}

fn random_bytes() -> Vec<u8> {
    let mut b = vec![0u8; 32];
    rand::fill(&mut b[..]);
    b
}

fn random_token() -> String {
    b64(&random_bytes())
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub fn create_invite(db: &Db, ttl_secs: i64) -> Result<(String, i64)> {
    let token = random_token();
    let expires = db.create_invite(&hash(&token), ttl_secs)?;
    Ok((token, expires))
}

/// The signed-in session, available to handlers behind `require_session`.
#[derive(Clone)]
pub struct Session {
    pub passkey_id: Vec<u8>,
}

fn cookie_name(app: &AppState) -> &'static str {
    // The __Host- prefix pins the cookie to this exact origin, but needs https.
    if app.secure_cookies {
        "__Host-dw_session"
    } else {
        "dw_session"
    }
}

fn session_token(app: &AppState, headers: &HeaderMap) -> Option<String> {
    let name = cookie_name(app);
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

fn current_session(app: &AppState, headers: &HeaderMap) -> Option<Session> {
    let token = session_token(app, headers)?;
    let passkey_id = app.db.session(&hash(&token)).ok()??;
    Some(Session { passkey_id })
}

fn session_cookie(app: &AppState, token: &str, max_age: i64) -> String {
    format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        cookie_name(app),
        if app.secure_cookies { "; Secure" } else { "" }
    )
}

fn start_session(app: &AppState, passkey_id: &[u8]) -> Result<String, ApiError> {
    let token = random_token();
    app.db
        .create_session(&hash(&token), passkey_id, SESSION_TTL)?;
    Ok(session_cookie(app, &token, SESSION_TTL))
}

/// Requests that change state must come from our own origin. Browsers always
/// send `Origin` on such requests; together with SameSite=Strict cookies and
/// JSON bodies this closes off CSRF.
fn origin_ok(app: &AppState, req: &Request) -> bool {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return true;
    }
    match req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        Some(o) => o == app.rp.origin,
        None => false,
    }
}

pub async fn require_session(State(app): State<App>, mut req: Request, next: Next) -> Response {
    if !origin_ok(&app, &req) {
        return ApiError::new(StatusCode::FORBIDDEN, "cross-origin request rejected")
            .into_response();
    }
    match current_session(&app, req.headers()) {
        Some(s) => {
            req.extensions_mut().insert(s);
            next.run(req).await
        }
        None => ApiError::new(StatusCode::UNAUTHORIZED, "sign in required").into_response(),
    }
}

pub async fn check_origin(State(app): State<App>, req: Request, next: Next) -> Response {
    if !origin_ok(&app, &req) {
        return ApiError::new(StatusCode::FORBIDDEN, "cross-origin request rejected")
            .into_response();
    }
    next.run(req).await
}

// ---- handlers ----

pub async fn status(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(json!({
        "authenticated": current_session(&app, &headers).is_some(),
        "setupRequired": app.db.passkey_count()? == 0,
        "rpId": app.rp.id,
        "version": crate::VERSION,
    })))
}

pub async fn login_begin(State(app): State<App>) -> Result<impl IntoResponse, ApiError> {
    let (id, challenge) = app.challenges.insert(Ceremony::Login)?;
    Ok(Json(
        json!({ "challengeId": id, "options": app.rp.request_options(&challenge) }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginFinish {
    challenge_id: String,
    credential: AssertionCredential,
}

pub async fn login_finish(
    State(app): State<App>,
    Json(body): Json<LoginFinish>,
) -> Result<Response, ApiError> {
    let pending = app
        .challenges
        .take(&body.challenge_id)
        .filter(|p| matches!(p.ceremony, Ceremony::Login))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "sign-in attempt expired, please try again",
            )
        })?;
    let id = unb64(&body.credential.raw_id).map_err(ApiError::bad_request)?;
    let pk = app.db.passkey(&id)?.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "this passkey is not registered here",
        )
    })?;
    let count = app
        .rp
        .verify_assertion(
            &pending.challenge,
            &body.credential,
            &pk.public_key,
            pk.sign_count,
        )
        .map_err(|e| {
            tracing::warn!("passkey sign-in failed: {e:#}");
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                format!("passkey verification failed: {e}"),
            )
        })?;
    app.db.passkey_used(&id, count)?;
    let cookie = start_session(&app, &id)?;
    tracing::info!("signed in with passkey '{}'", pk.name);
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response())
}

#[derive(Deserialize, Default)]
pub struct RegisterBegin {
    invite: Option<String>,
}

pub async fn register_begin(
    State(app): State<App>,
    headers: HeaderMap,
    body: Option<Json<RegisterBegin>>,
) -> Result<impl IntoResponse, ApiError> {
    let invite = body.and_then(|b| b.0.invite).filter(|s| !s.is_empty());
    let invite_hash = match (current_session(&app, &headers), invite) {
        (Some(_), _) => None,
        (None, Some(token)) => {
            let h = hash(&token);
            if !app.db.invite_valid(&h)? {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "this invite link is invalid, used or expired",
                ));
            }
            Some(h)
        }
        (None, None) => {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "an invite link or a session is required",
            ));
        }
    };
    let user_handle =
        unb64(&app.db.meta_get("user_handle")?.unwrap_or_default()).map_err(ApiError::internal)?;
    let exclude: Vec<Vec<u8>> = app.db.passkeys()?.into_iter().map(|p| p.id).collect();
    let (id, challenge) = app.challenges.insert(Ceremony::Register { invite_hash })?;
    Ok(Json(json!({
        "challengeId": id,
        "options": app.rp.creation_options(&challenge, &user_handle, &exclude),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterFinish {
    challenge_id: String,
    name: String,
    credential: RegistrationCredential,
}

pub async fn register_finish(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<RegisterFinish>,
) -> Result<Response, ApiError> {
    let pending = app.challenges.take(&body.challenge_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "registration expired, please try again",
        )
    })?;
    let Ceremony::Register { invite_hash } = pending.ceremony else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "wrong ceremony"));
    };
    let session = current_session(&app, &headers);
    if session.is_none() && invite_hash.is_none() {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "sign in required"));
    }
    let cred = app
        .rp
        .verify_registration(&pending.challenge, &body.credential)
        .map_err(|e| {
            tracing::warn!("passkey registration failed: {e:#}");
            ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("passkey verification failed: {e}"),
            )
        })?;
    if let Some(h) = &invite_hash
        && !app.db.consume_invite(h)?
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "this invite link was already used or has expired",
        ));
    }
    let name = clean_name(&body.name, "Passkey");
    app.db
        .insert_passkey(&cred.id, &name, &cred.public_key, cred.sign_count)?;
    tracing::info!("registered passkey '{name}'");
    let mut res = Json(json!({ "ok": true })).into_response();
    if session.is_none() {
        let cookie = start_session(&app, &cred.id)?;
        res.headers_mut().insert(
            header::SET_COOKIE,
            cookie.parse().map_err(ApiError::internal)?,
        );
    }
    Ok(res)
}

pub async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<Response, ApiError> {
    if let Some(token) = session_token(&app, &headers) {
        app.db.delete_session(&hash(&token))?;
    }
    Ok((
        [(header::SET_COOKIE, session_cookie(&app, "", 0))],
        Json(json!({ "ok": true })),
    )
        .into_response())
}

pub fn clean_name(s: &str, fallback: &str) -> String {
    let s: String = s
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    if s.is_empty() {
        fallback.to_string()
    } else {
        s
    }
}
