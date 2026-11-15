//! The set of machines the control server can read logs from: the optional
//! local Docker socket plus every registered agent. A poller keeps a cached
//! status and container list for each one.

use std::collections::HashMap;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use futures_util::{Stream, StreamExt};
use hyper::Response;
use hyper::body::Incoming;
use rustls_pki_types::ServerName;
use serde::Serialize;
use tokio::net::TcpStream;
use tokio::sync::{Notify, RwLock};
use tokio_rustls::TlsConnector;

use super::db::{AgentRow, now};
use crate::agent::HEARTBEAT;
use crate::docker::Docker;
use crate::model::{ContainerInfo, HostInfo, LogEvent};
use crate::{dns, http, pki};

pub type EventStream = Pin<Box<dyn Stream<Item = LogEvent> + Send>>;

pub const LOCAL_ID: &str = "local";

pub struct AgentClient {
    pub id: String,
    pub address: String,
    pub port: u16,
    pub fingerprint: String,
    pub tls: Arc<rustls::ClientConfig>,
    pub dns: Option<IpAddr>,
    /// Appended to single-label host names, e.g. `tail1234.ts.net`.
    pub search_domain: Option<String>,
}

impl AgentClient {
    fn dial_host(&self) -> String {
        match &self.search_domain {
            Some(d) if !self.address.contains('.') && !self.address.contains(':') => {
                format!("{}.{d}", self.address)
            }
            _ => self.address.clone(),
        }
    }

    async fn get(&self, path: &str) -> Result<Response<Incoming>> {
        let host = self.dial_host();
        let addr = dns::resolve(&host, self.port, self.dns).await?;
        let tcp = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(addr))
            .await
            .with_context(|| format!("connecting to {host} ({addr}) timed out"))?
            .with_context(|| format!("connect to {host} ({addr})"))?;
        let _ = tcp.set_nodelay(true);
        // The TLS server name is the agent's certificate identity, independent
        // of how we reached it.
        let name = ServerName::try_from(pki::agent_san(&self.id))?;
        let tls = tokio::time::timeout(
            Duration::from_secs(5),
            TlsConnector::from(self.tls.clone()).connect(name, tcp),
        )
        .await
        .context("TLS handshake timed out")?
        .context("TLS handshake failed")?;
        let peer = tls
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|c| c.first())
            .context("agent sent no certificate")?;
        if pki::fingerprint(peer.as_ref()) != self.fingerprint {
            bail!(
                "agent presented an outdated certificate; update its environment with the latest snippet"
            );
        }
        http::send(tls, http::get(path, &pki::agent_san(&self.id))?).await
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let fut = async {
            let res = self.get(path).await?;
            let body = http::read_ok(res).await?;
            serde_json::from_slice(&body).context("decode agent response")
        };
        tokio::time::timeout(Duration::from_secs(15), fut)
            .await
            .context("agent request timed out")?
    }
}

pub enum Target {
    Local(Docker),
    Remote(AgentClient),
}

pub struct Machine {
    pub id: String,
    pub name: String,
    pub target: Target,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub online: bool,
    pub checked_at: Option<i64>,
    pub last_seen: Option<i64>,
    pub error: Option<String>,
    pub latency_ms: Option<u64>,
    pub info: Option<HostInfo>,
    pub containers: Vec<ContainerInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineView {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub address: Option<String>,
    #[serde(flatten)]
    pub status: Status,
}

impl Machine {
    pub fn local(name: String, docker: Docker) -> Self {
        Machine {
            id: LOCAL_ID.into(),
            name,
            target: Target::Local(docker),
        }
    }

    pub fn remote(
        row: &AgentRow,
        tls: Arc<rustls::ClientConfig>,
        dns: Option<IpAddr>,
        search_domain: Option<String>,
    ) -> Self {
        Machine {
            id: row.id.clone(),
            name: row.name.clone(),
            target: Target::Remote(AgentClient {
                id: row.id.clone(),
                address: row.address.clone(),
                port: row.port,
                fingerprint: row.fingerprint.clone(),
                tls,
                dns,
                search_domain,
            }),
        }
    }

    pub async fn info(&self) -> Result<HostInfo> {
        match &self.target {
            Target::Local(d) => d.info().await,
            Target::Remote(c) => c.get_json("/v1/info").await,
        }
    }

    pub async fn containers(&self) -> Result<Vec<ContainerInfo>> {
        match &self.target {
            Target::Local(d) => d.containers().await,
            Target::Remote(c) => c.get_json("/v1/containers").await,
        }
    }

    /// A never-ending (until all containers are removed or the viewer leaves)
    /// stream of log events. Remote streams reconnect after network trouble
    /// and resume from the last line received.
    pub fn logs(self: Arc<Self>, ids: Vec<String>, tail: u32, since: Option<i64>) -> EventStream {
        if let Target::Local(d) = &self.target {
            return d.follow_many(ids, Some(tail), since);
        }
        Box::pin(async_stream::stream! {
            let Target::Remote(client) = &self.target else { return };
            let mut last_t: Option<i64> = since;
            let started = crate::docker::now_micros();
            let mut first = true;
            let list = ids.join(",");
            loop {
                let path = match last_t {
                    Some(t) => format!("/v1/logs?containers={list}&since={}", t + 1),
                    None if first => format!("/v1/logs?containers={list}&tail={tail}"),
                    None => format!("/v1/logs?containers={list}&since={started}"),
                };
                match client.get(&path).await {
                    Ok(res) if res.status().is_success() => {
                        if !first {
                            yield LogEvent::state("*", "connected", None);
                        }
                        let mut lines = std::pin::pin!(http::lines(res.into_body()));
                        loop {
                            match tokio::time::timeout(HEARTBEAT * 3, lines.next()).await {
                                Ok(Some(Ok(line))) => {
                                    let Ok(ev) = serde_json::from_slice::<LogEvent>(&line) else { continue };
                                    if matches!(&ev, LogEvent::State { state, .. } if state == "ping") {
                                        continue;
                                    }
                                    if let Some(t) = ev.time() {
                                        last_t = Some(t);
                                    }
                                    yield ev;
                                }
                                Ok(Some(Err(e))) => {
                                    tracing::debug!("stream from {} broke: {e:#}", client.id);
                                    yield LogEvent::state("*", "disconnected", Some("connection to the agent was lost".into()));
                                    break;
                                }
                                // The agent ended the stream: every container is gone.
                                Ok(None) => return,
                                Err(_) => {
                                    yield LogEvent::state("*", "disconnected", Some("agent stopped responding".into()));
                                    break;
                                }
                            }
                        }
                    }
                    Ok(res) => {
                        let status = res.status();
                        let text = http::read_ok(res).await.err().map(|e| format!("{e:#}")).unwrap_or_default();
                        yield LogEvent::state("*", "error", Some(text));
                        if status.is_client_error() {
                            return;
                        }
                    }
                    Err(e) => {
                        yield LogEvent::state("*", "unreachable", Some(format!("{e:#}")));
                    }
                }
                first = false;
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        })
    }
}

#[derive(Default)]
pub struct Registry {
    machines: RwLock<Vec<Arc<Machine>>>,
    status: RwLock<HashMap<String, Status>>,
    pub wake: Notify,
}

impl Registry {
    pub async fn set_machines(&self, machines: Vec<Machine>) {
        let machines: Vec<Arc<Machine>> = machines.into_iter().map(Arc::new).collect();
        let ids: Vec<String> = machines.iter().map(|m| m.id.clone()).collect();
        *self.machines.write().await = machines;
        self.status.write().await.retain(|id, _| ids.contains(id));
        self.wake.notify_one();
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Machine>> {
        self.machines
            .read()
            .await
            .iter()
            .find(|m| m.id == id)
            .cloned()
    }

    pub async fn status(&self, id: &str) -> Status {
        self.status
            .read()
            .await
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    pub async fn views(&self) -> Vec<MachineView> {
        let machines = self.machines.read().await.clone();
        let status = self.status.read().await;
        let mut out: Vec<MachineView> = machines
            .iter()
            .map(|m| MachineView {
                id: m.id.clone(),
                name: m.name.clone(),
                kind: match m.target {
                    Target::Local(_) => "local",
                    Target::Remote(_) => "agent",
                },
                address: match &m.target {
                    Target::Local(_) => None,
                    Target::Remote(c) => Some(format!("{}:{}", c.address, c.port)),
                },
                status: status.get(&m.id).cloned().unwrap_or_default(),
            })
            .collect();
        out.sort_by_key(|m| (m.kind != "local", m.name.to_lowercase()));
        out
    }

    async fn poll_one(&self, m: Arc<Machine>) {
        let start = Instant::now();
        let result =
            async { Ok::<_, anyhow::Error>((m.info().await?, m.containers().await?)) }.await;
        let mut status = self.status.write().await;
        let entry = status.entry(m.id.clone()).or_default();
        entry.checked_at = Some(now());
        match result {
            Ok((info, containers)) => {
                if !entry.online {
                    tracing::info!("{} ({}) is online", m.name, m.id);
                }
                entry.online = true;
                entry.last_seen = Some(now());
                entry.error = None;
                entry.latency_ms = Some(start.elapsed().as_millis() as u64);
                entry.info = Some(info);
                entry.containers = containers;
            }
            Err(e) => {
                let msg = format!("{e:#}");
                if entry.online || entry.error.as_deref() != Some(&msg) {
                    tracing::warn!("{} ({}) is unreachable: {msg}", m.name, m.id);
                }
                entry.online = false;
                entry.error = Some(msg);
                entry.latency_ms = None;
            }
        }
    }

    pub async fn poll_all(&self) {
        let machines = self.machines.read().await.clone();
        futures_util::future::join_all(machines.into_iter().map(|m| self.poll_one(m))).await;
    }

    pub async fn run_poller(self: Arc<Self>, interval: Duration) {
        loop {
            self.poll_all().await;
            tokio::select! {
                _ = tokio::time::sleep(interval) => {},
                _ = self.wake.notified() => {},
            }
        }
    }
}
