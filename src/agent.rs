//! Agent mode: serves this machine's Docker logs over mutual TLS. It keeps no
//! state; everything comes from environment variables.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use bytes::Bytes;
use futures_util::StreamExt;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::service::TowerToHyperService;
use serde::Deserialize;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

use crate::config::{AgentConfig, decode_pem};
use crate::docker::{self, Docker};
use crate::model::{LogEvent, valid_container_ref};
use crate::pki;

/// How often an idle log stream sends a keep-alive event.
pub const HEARTBEAT: Duration = Duration::from_secs(15);

#[derive(Clone)]
struct AgentState {
    docker: Docker,
}

pub async fn run(cfg: AgentConfig) -> Result<()> {
    let ca = decode_pem("DRIFTWATCH_CA", cfg.ca.as_deref())?;
    let cert = decode_pem("DRIFTWATCH_CERT", cfg.cert.as_deref())?;
    let key = decode_pem("DRIFTWATCH_KEY", cfg.key.as_deref())?;
    let id = pki::agent_id_from_cert(&cert)?;
    let tls = pki::server_config(&ca, &cert, &key).context("build TLS config")?;

    let docker = Docker::new(&cfg.docker);
    match docker.info().await {
        Ok(i) => tracing::info!("connected to Docker {} on {}", i.docker_version, i.hostname),
        Err(e) => tracing::warn!("Docker is not reachable yet: {e:#}"),
    }

    let app = Router::new()
        .route("/v1/info", get(info))
        .route("/v1/containers", get(containers))
        .route("/v1/logs", get(logs))
        .with_state(AgentState { docker });

    let listener = TcpListener::bind(cfg.listen)
        .await
        .with_context(|| format!("bind {}", cfg.listen))?;
    tracing::info!("agent '{id}' listening on {} (mutual TLS)", cfg.listen);

    let acceptor = TlsAcceptor::from(tls);
    let shutdown = crate::shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            accepted = listener.accept() => {
                let (tcp, peer) = match accepted {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!("accept failed: {e}");
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        continue;
                    }
                };
                tokio::spawn(serve_conn(acceptor.clone(), tcp, peer, app.clone()));
            }
        }
    }
}

async fn serve_conn(acceptor: TlsAcceptor, tcp: TcpStream, peer: SocketAddr, app: Router) {
    let _ = tcp.set_nodelay(true);
    let tls = match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tcp)).await {
        Ok(Ok(tls)) => tls,
        // A bare TCP connect (e.g. the image HEALTHCHECK) is not worth a warning.
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return,
        Ok(Err(e)) => {
            tracing::warn!("TLS handshake with {peer} failed: {e}");
            return;
        }
        Err(_) => return,
    };
    // The CA also signs agent certificates; only the control certificate may connect.
    let is_control = tls
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|c| c.first())
        .and_then(|c| pki::dns_sans(c.as_ref()).ok())
        .is_some_and(|sans| sans.iter().any(|s| s == pki::CONTROL_SAN));
    if !is_control {
        tracing::warn!("rejected {peer}: client certificate is not the control certificate");
        return;
    }
    let service = TowerToHyperService::new(app);
    if let Err(e) = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new())
        .serve_connection(TokioIo::new(tls), service)
        .await
    {
        tracing::debug!("connection from {peer} ended: {e}");
    }
}

struct AppError(anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (StatusCode::BAD_GATEWAY, format!("{:#}", self.0)).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.into())
    }
}

async fn info(State(s): State<AgentState>) -> Result<impl IntoResponse, AppError> {
    Ok(Json(s.docker.info().await?))
}

async fn containers(State(s): State<AgentState>) -> Result<impl IntoResponse, AppError> {
    Ok(Json(s.docker.containers().await?))
}

#[derive(Deserialize)]
pub struct LogsQuery {
    /// Comma separated container ids or names.
    pub containers: String,
    pub tail: Option<u32>,
    /// Unix microseconds; overrides `tail`.
    pub since: Option<i64>,
}

async fn logs(
    State(s): State<AgentState>,
    Query(q): Query<LogsQuery>,
) -> Result<Response, AppError> {
    let refs: Vec<String> = q
        .containers
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    if refs.iter().any(|r| !valid_container_ref(r)) {
        return Ok((StatusCode::BAD_REQUEST, "invalid container reference").into_response());
    }
    let all = s.docker.containers().await?;
    let ids = docker::resolve_ids(&all, &refs).map_err(AppError)?;
    let events = with_heartbeat(
        s.docker
            .follow_many(ids, Some(q.tail.unwrap_or(200)), q.since),
    );
    let body = events.map(|ev| {
        let mut line = serde_json::to_vec(&ev).unwrap_or_default();
        line.push(b'\n');
        Ok::<_, Infallible>(Bytes::from(line))
    });
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(body),
    )
        .into_response())
}

/// Interleaves keep-alive events so the control server can detect dead links.
pub fn with_heartbeat(
    inner: std::pin::Pin<Box<dyn futures_util::Stream<Item = LogEvent> + Send>>,
) -> impl futures_util::Stream<Item = LogEvent> + Send {
    async_stream::stream! {
        let mut inner = inner;
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
        loop {
            tokio::select! {
                ev = inner.next() => match ev {
                    Some(ev) => yield ev,
                    None => break,
                },
                _ = tick.tick() => yield LogEvent::state("*", "ping", None),
            }
        }
    }
}
