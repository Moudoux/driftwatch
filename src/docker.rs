//! A small read-only Docker Engine API client. Only GET requests are ever made.

use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use futures_util::Stream;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::{Response, StatusCode};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::net::{TcpStream, UnixStream};

use crate::http;
use crate::model::{ContainerInfo, HostInfo, LogEvent, StreamKind};

/// Longest single log message forwarded; longer ones are truncated.
const MAX_LINE: usize = 16 * 1024;

#[derive(Clone, Debug)]
enum Endpoint {
    Unix(PathBuf),
    Tcp(String),
}

#[derive(Clone, Debug)]
pub struct Docker {
    endpoint: Endpoint,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawContainer {
    id: String,
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    image: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    created: i64,
    #[serde(default)]
    labels: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawInfo {
    #[serde(default)]
    name: String,
    #[serde(default)]
    server_version: String,
    #[serde(default)]
    operating_system: String,
    #[serde(default)]
    architecture: String,
    #[serde(default, rename = "NCPU")]
    ncpu: i64,
    #[serde(default)]
    mem_total: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Inspect {
    state: InspectState,
    config: InspectConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectState {
    #[serde(default)]
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectConfig {
    #[serde(default)]
    tty: bool,
}

impl Docker {
    pub fn new(spec: &str) -> Self {
        let endpoint = if let Some(rest) = spec
            .strip_prefix("tcp://")
            .or_else(|| spec.strip_prefix("http://"))
        {
            Endpoint::Tcp(rest.trim_end_matches('/').to_string())
        } else {
            Endpoint::Unix(PathBuf::from(spec.strip_prefix("unix://").unwrap_or(spec)))
        };
        Docker { endpoint }
    }

    async fn get(&self, path: &str) -> Result<Response<Incoming>> {
        match &self.endpoint {
            Endpoint::Unix(p) => {
                let s = UnixStream::connect(p)
                    .await
                    .with_context(|| format!("connect to Docker socket {}", p.display()))?;
                http::send(s, http::get(path, "docker")?).await
            }
            Endpoint::Tcp(addr) => {
                let s = TcpStream::connect(addr)
                    .await
                    .with_context(|| format!("connect to Docker at {addr}"))?;
                http::send(s, http::get(path, addr)?).await
            }
        }
    }

    async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let res = tokio::time::timeout(Duration::from_secs(15), self.get(path))
            .await
            .context("Docker request timed out")??;
        let body = http::read_ok(res).await?;
        serde_json::from_slice(&body).context("decode Docker response")
    }

    pub async fn info(&self) -> Result<HostInfo> {
        let i: RawInfo = self.get_json("/info").await?;
        Ok(HostInfo {
            version: crate::VERSION.to_string(),
            hostname: i.name,
            docker_version: i.server_version,
            os: i.operating_system,
            arch: i.architecture,
            cpus: i.ncpu,
            mem_total: i.mem_total,
        })
    }

    pub async fn containers(&self) -> Result<Vec<ContainerInfo>> {
        let raw: Vec<RawContainer> = self.get_json("/containers/json?all=1").await?;
        let mut out: Vec<ContainerInfo> = raw
            .into_iter()
            .map(|c| {
                let labels = c.labels.unwrap_or_default();
                let name = c
                    .names
                    .first()
                    .map(|n| n.trim_start_matches('/').to_string())
                    .unwrap_or_else(|| c.id.chars().take(12).collect());
                ContainerInfo {
                    id: c.id,
                    name,
                    image: c.image,
                    state: c.state,
                    status: c.status,
                    created: c.created,
                    project: labels.get("com.docker.compose.project").cloned(),
                    service: labels.get("com.docker.compose.service").cloned(),
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// Returns `Ok(None)` if the container does not exist.
    async fn inspect(&self, id: &str) -> Result<Option<Inspect>> {
        let res = self.get(&format!("/containers/{id}/json")).await?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let body = http::read_ok(res).await?;
        Ok(Some(serde_json::from_slice(&body)?))
    }

    /// Follows the logs of several containers, merged into one stream.
    pub fn follow_many(
        &self,
        ids: Vec<String>,
        tail: Option<u32>,
        since_micros: Option<i64>,
    ) -> Pin<Box<dyn Stream<Item = LogEvent> + Send>> {
        let streams = ids
            .into_iter()
            .map(|id| self.clone().follow(id, tail, since_micros));
        Box::pin(futures_util::stream::select_all(streams))
    }

    /// Follows one container's logs forever: when the container stops the
    /// stream waits for it to start again and resumes where it left off. It
    /// ends only when the container is removed.
    pub fn follow(
        self,
        id: String,
        tail: Option<u32>,
        since_micros: Option<i64>,
    ) -> Pin<Box<dyn Stream<Item = LogEvent> + Send>> {
        Box::pin(async_stream::stream! {
            let mut last_t: Option<i64> = since_micros;
            let started = now_micros();
            let mut first = true;
            loop {
                let inspect = match self.inspect(&id).await {
                    Ok(Some(i)) => i,
                    Ok(None) => {
                        yield LogEvent::state(&id, "removed", None);
                        return;
                    }
                    Err(e) => {
                        yield LogEvent::state(&id, "error", Some(format!("{e:#}")));
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                };
                yield LogEvent::state(&id, &inspect.state.status, None);

                let mut path = format!(
                    "/containers/{id}/logs?follow=1&stdout=1&stderr=1&timestamps=1"
                );
                // On the first request honour `tail`/`since`; when resuming
                // after a restart continue from the last line we saw.
                let since = if first { last_t } else { Some(last_t.unwrap_or(started)) };
                match since {
                    Some(t) => path.push_str(&format!("&since={}.{:06}", t.div_euclid(1_000_000), t.rem_euclid(1_000_000))),
                    None => match tail {
                        Some(n) => path.push_str(&format!("&tail={n}")),
                        None => path.push_str("&tail=all"),
                    },
                }
                // Docker's `since` is not exact, so also drop anything at or before it.
                let resume_after = if first { since_micros.map(|s| s - 1) } else { since };
                first = false;

                match self.get(&path).await {
                    Ok(res) if res.status().is_success() => {
                        let mut decoder = Decoder::new(inspect.config.tty);
                        let mut body = res.into_body();
                        loop {
                            let frame = match body.frame().await {
                                Some(Ok(f)) => f,
                                Some(Err(e)) => {
                                    tracing::debug!("log stream for {id} broke: {e}");
                                    break;
                                }
                                None => break,
                            };
                            let Ok(data) = frame.into_data() else { continue };
                            for (kind, raw) in decoder.push(&data) {
                                let ev = to_event(&id, kind, &raw);
                                if let (Some(after), Some(t)) = (resume_after, ev.time())
                                    && t <= after {
                                        continue;
                                    }
                                last_t = ev.time().or(last_t);
                                yield ev;
                            }
                        }
                        for (kind, raw) in decoder.finish() {
                            let ev = to_event(&id, kind, &raw);
                            last_t = ev.time().or(last_t);
                            yield ev;
                        }
                    }
                    Ok(res) => {
                        let status = res.status();
                        let text = res.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                        yield LogEvent::state(&id, "error", Some(format!("Docker returned {status}: {}", String::from_utf8_lossy(&text).trim())));
                    }
                    Err(e) => {
                        yield LogEvent::state(&id, "error", Some(format!("{e:#}")));
                    }
                }

                // The log stream ended: the container stopped (or Docker
                // restarted). Wait until it runs again.
                let mut announced = false;
                loop {
                    match self.inspect(&id).await {
                        Ok(None) => {
                            yield LogEvent::state(&id, "removed", None);
                            return;
                        }
                        Ok(Some(i)) if i.state.status == "running" => break,
                        Ok(Some(i)) => {
                            if !announced {
                                yield LogEvent::state(&id, &i.state.status, None);
                                announced = true;
                            }
                        }
                        Err(_) => {}
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        })
    }
}

fn to_event(id: &str, kind: StreamKind, raw: &[u8]) -> LogEvent {
    // With timestamps=1 every line starts with an RFC 3339 timestamp and a space.
    let (t, msg) = match raw.iter().position(|b| *b == b' ') {
        Some(pos) => match parse_ts(&raw[..pos]) {
            Some(t) => (t, &raw[pos + 1..]),
            None => (now_micros(), raw),
        },
        None => match parse_ts(raw) {
            Some(t) => (t, &raw[raw.len()..]),
            None => (now_micros(), raw),
        },
    };
    let msg = if msg.len() > MAX_LINE {
        &msg[..MAX_LINE]
    } else {
        msg
    };
    let mut m = String::from_utf8_lossy(msg).into_owned();
    if m.ends_with('\r') {
        m.pop();
    }
    LogEvent::Line {
        c: id.to_string(),
        s: kind,
        t,
        m,
    }
}

fn parse_ts(b: &[u8]) -> Option<i64> {
    let s = std::str::from_utf8(b).ok()?;
    let t = time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()?;
    Some((t.unix_timestamp_nanos() / 1000) as i64)
}

pub fn now_micros() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1000) as i64
}

/// Turns Docker's log byte stream into lines. Non-TTY containers use the
/// multiplexed format: an 8 byte header `[stream, 0, 0, 0, len(u32 BE)]`
/// followed by `len` bytes of payload.
struct Decoder {
    tty: bool,
    pending: Vec<u8>,
    out: Vec<u8>,
    err: Vec<u8>,
}

impl Decoder {
    fn new(tty: bool) -> Self {
        Decoder {
            tty,
            pending: Vec::new(),
            out: Vec::new(),
            err: Vec::new(),
        }
    }

    fn push(&mut self, data: &Bytes) -> Vec<(StreamKind, Vec<u8>)> {
        let mut lines = Vec::new();
        if self.tty {
            split_lines(&mut self.out, data, StreamKind::Stdout, &mut lines);
            return lines;
        }
        self.pending.extend_from_slice(data);
        let mut offset = 0;
        while self.pending.len() - offset >= 8 {
            let header = &self.pending[offset..offset + 8];
            let len = u32::from_be_bytes([header[4], header[5], header[6], header[7]]) as usize;
            if self.pending.len() - offset < 8 + len {
                break;
            }
            let (kind, buf) = match header[0] {
                2 => (StreamKind::Stderr, &mut self.err),
                _ => (StreamKind::Stdout, &mut self.out),
            };
            let payload = &self.pending[offset + 8..offset + 8 + len];
            split_lines(buf, payload, kind, &mut lines);
            offset += 8 + len;
        }
        self.pending.drain(..offset);
        lines
    }

    fn finish(&mut self) -> Vec<(StreamKind, Vec<u8>)> {
        let mut lines = Vec::new();
        if !self.out.is_empty() {
            lines.push((StreamKind::Stdout, std::mem::take(&mut self.out)));
        }
        if !self.err.is_empty() {
            lines.push((StreamKind::Stderr, std::mem::take(&mut self.err)));
        }
        lines
    }
}

fn split_lines(
    buf: &mut Vec<u8>,
    data: &[u8],
    kind: StreamKind,
    out: &mut Vec<(StreamKind, Vec<u8>)>,
) {
    for chunk in data.split_inclusive(|b| *b == b'\n') {
        if let Some(line) = chunk.strip_suffix(b"\n") {
            buf.extend_from_slice(line);
            out.push((kind, std::mem::take(buf)));
        } else {
            buf.extend_from_slice(chunk);
            // Guard against a writer that never emits a newline.
            if buf.len() > 4 * MAX_LINE {
                out.push((kind, std::mem::take(buf)));
            }
        }
    }
}

/// Checks the container list for a name/id and returns its id.
pub fn resolve_ids(containers: &[ContainerInfo], refs: &[String]) -> Result<Vec<String>> {
    refs.iter()
        .map(|r| {
            containers
                .iter()
                .find(|c| {
                    c.id == *r || c.name == *r || (r.len() >= 12 && c.id.starts_with(r.as_str()))
                })
                .map(|c| c.id.clone())
                .with_context(|| format!("no such container: {r}"))
        })
        .collect::<Result<Vec<_>>>()
        .and_then(|v| {
            if v.is_empty() {
                bail!("no containers requested")
            } else {
                Ok(v)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(stream: u8, payload: &[u8]) -> Vec<u8> {
        let mut v = vec![stream, 0, 0, 0];
        v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn multiplexed_frames_split_across_chunks() {
        let mut data = frame(1, b"2024-01-02T03:04:05.123456789Z hello\n");
        data.extend(frame(2, b"2024-01-02T03:04:06Z oops\n"));
        let mut d = Decoder::new(false);
        let (a, b) = data.split_at(13);
        let mut lines = d.push(&Bytes::copy_from_slice(a));
        assert!(lines.is_empty());
        lines.extend(d.push(&Bytes::copy_from_slice(b)));
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].0, StreamKind::Stderr);
        match to_event("x", lines[0].0, &lines[0].1) {
            LogEvent::Line { t, m, .. } => {
                assert_eq!(m, "hello");
                assert_eq!(t, 1704164645123456);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn tty_lines() {
        let mut d = Decoder::new(true);
        let lines = d.push(&Bytes::from_static(
            b"2024-01-02T03:04:05Z a\r\n2024-01-02T03:04:05Z b",
        ));
        assert_eq!(lines.len(), 1);
        let rest = d.finish();
        assert_eq!(rest.len(), 1);
        match to_event("x", lines[0].0, &lines[0].1) {
            LogEvent::Line { m, .. } => assert_eq!(m, "a"),
            _ => panic!(),
        }
    }
}
