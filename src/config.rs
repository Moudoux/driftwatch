use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use base64::Engine;
use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Parser, Debug)]
#[command(
    name = "driftwatch",
    version,
    about = "Live Docker logs from every machine, over Tailscale and mutual TLS"
)]
pub struct Cli {
    /// Run as a log agent or as the control server.
    #[arg(
        long,
        env = "DRIFTWATCH_MODE",
        value_enum,
        default_value = "agent",
        global = true
    )]
    pub mode: Mode,

    #[command(flatten)]
    pub agent: AgentConfig,

    #[command(flatten)]
    pub control: ControlConfig,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum Mode {
    Agent,
    Control,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Run the server (the default).
    Serve,
    /// Control only: print a one-time link that registers a new passkey.
    /// Run it interactively, e.g. `docker exec -it driftwatch driftwatch invite`.
    Invite {
        /// How long the link stays valid.
        #[arg(long, default_value_t = 30)]
        minutes: u32,
    },
    /// Exit 0 if the server port accepts connections (used by the image HEALTHCHECK).
    Healthcheck,
    /// Print the version.
    Version,
}

#[derive(Args, Debug, Clone)]
pub struct AgentConfig {
    /// Address the agent's mTLS server listens on.
    #[arg(
        long = "listen",
        env = "DRIFTWATCH_LISTEN",
        default_value = "0.0.0.0:7443",
        global = true
    )]
    pub listen: SocketAddr,

    /// CA certificate (PEM, or base64 of PEM) issued by the control server.
    #[arg(
        long = "ca",
        env = "DRIFTWATCH_CA",
        hide_env_values = true,
        global = true
    )]
    pub ca: Option<String>,

    /// This agent's certificate (PEM, or base64 of PEM).
    #[arg(
        long = "cert",
        env = "DRIFTWATCH_CERT",
        hide_env_values = true,
        global = true
    )]
    pub cert: Option<String>,

    /// This agent's private key (PEM, or base64 of PEM).
    #[arg(
        long = "key",
        env = "DRIFTWATCH_KEY",
        hide_env_values = true,
        global = true
    )]
    pub key: Option<String>,

    /// Docker endpoint: a unix socket path, unix://path, or tcp://host:port
    /// (for example a docker-socket-proxy).
    #[arg(
        long = "docker",
        env = "DRIFTWATCH_DOCKER",
        default_value = "/var/run/docker.sock",
        global = true
    )]
    pub docker: String,
}

#[derive(Args, Debug, Clone)]
pub struct ControlConfig {
    /// Address the web UI / API listens on.
    #[arg(
        long = "http-listen",
        env = "DRIFTWATCH_HTTP_LISTEN",
        default_value = "0.0.0.0:8080",
        global = true
    )]
    pub http_listen: SocketAddr,

    /// The URL you open in the browser. Passkeys are bound to its host name.
    #[arg(
        long = "public-url",
        env = "DRIFTWATCH_PUBLIC_URL",
        default_value = "http://localhost:8080",
        global = true
    )]
    pub public_url: String,

    /// Where the SQLite database lives.
    #[arg(
        long = "data-dir",
        env = "DRIFTWATCH_DATA_DIR",
        default_value = "/data",
        global = true
    )]
    pub data_dir: PathBuf,

    /// Also collect logs from this machine's Docker socket.
    #[arg(
        long = "local",
        env = "DRIFTWATCH_LOCAL",
        default_value_t = false,
        global = true
    )]
    pub local: bool,

    /// Display name for the local machine (defaults to the Docker host name).
    #[arg(long = "local-name", env = "DRIFTWATCH_LOCAL_NAME", global = true)]
    pub local_name: Option<String>,

    /// Docker endpoint for local collection.
    #[arg(
        long = "local-docker",
        env = "DRIFTWATCH_LOCAL_DOCKER",
        default_value = "/var/run/docker.sock",
        global = true
    )]
    pub local_docker: String,

    /// DNS server used to resolve agent host names, e.g. 100.100.100.100
    /// for Tailscale MagicDNS. Falls back to the system resolver.
    #[arg(long = "dns", env = "DRIFTWATCH_DNS", global = true)]
    pub dns: Option<std::net::IpAddr>,

    /// Image reference used in generated compose snippets.
    #[arg(
        long = "image",
        env = "DRIFTWATCH_IMAGE",
        default_value = "ghcr.io/moudoux/driftwatch:latest",
        global = true
    )]
    pub image: String,

    /// How often agents are polled for status and container lists, in seconds.
    #[arg(
        long = "poll-interval",
        env = "DRIFTWATCH_POLL_INTERVAL",
        default_value_t = 10,
        global = true
    )]
    pub poll_interval: u64,
}

/// Accepts either a raw PEM string or base64 of a PEM string (handy for
/// single-line environment variables).
pub fn decode_pem(name: &str, value: Option<&str>) -> Result<String> {
    let value = value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .with_context(|| format!("{name} is not set"))?;
    if value.starts_with("-----BEGIN") {
        return Ok(value.replace("\\n", "\n"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.as_bytes())
        .with_context(|| format!("{name} is neither PEM nor base64"))?;
    let pem = String::from_utf8(bytes).with_context(|| format!("{name} is not valid UTF-8"))?;
    if !pem.trim_start().starts_with("-----BEGIN") {
        bail!("{name} does not contain a PEM block");
    }
    Ok(pem)
}
