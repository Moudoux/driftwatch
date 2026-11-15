//! Types shared between agent, control server and the web UI (JSON).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    /// created, running, paused, restarting, removing, exited, dead
    pub state: String,
    /// Human readable status, e.g. "Up 3 hours (healthy)".
    pub status: String,
    /// Unix seconds.
    pub created: i64,
    /// `com.docker.compose.project`, if the container belongs to a compose project.
    pub project: Option<String>,
    /// `com.docker.compose.service`.
    pub service: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub version: String,
    pub hostname: String,
    pub docker_version: String,
    pub os: String,
    pub arch: String,
    pub cpus: i64,
    pub mem_total: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StreamKind {
    #[serde(rename = "o")]
    Stdout,
    #[serde(rename = "e")]
    Stderr,
}

/// One event in a log stream. Kept terse because there can be a lot of them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "k")]
pub enum LogEvent {
    /// A log line.
    #[serde(rename = "l")]
    Line {
        /// Container id.
        c: String,
        s: StreamKind,
        /// Unix time in microseconds.
        t: i64,
        /// The message.
        m: String,
    },
    /// The state of a stream changed (container stopped/started, agent
    /// unreachable, ...). `c` is a container id, or `*` for the whole stream.
    #[serde(rename = "s")]
    State {
        c: String,
        state: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        msg: Option<String>,
    },
}

impl LogEvent {
    pub fn state(c: impl Into<String>, state: &str, msg: Option<String>) -> Self {
        LogEvent::State {
            c: c.into(),
            state: state.into(),
            msg,
        }
    }

    pub fn time(&self) -> Option<i64> {
        match self {
            LogEvent::Line { t, .. } => Some(*t),
            LogEvent::State { .. } => None,
        }
    }
}

/// Container ids/names are put into URLs, so only allow a safe character set.
pub fn valid_container_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}
