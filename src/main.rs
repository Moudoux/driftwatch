//! Driftwatch: one binary that is either a log *agent* (reads the local Docker
//! socket and serves logs over mutual TLS) or the *control* server (stores
//! configuration, connects out to every agent and serves the web UI).

mod agent;
mod config;
mod control;
mod dns;
mod docker;
mod http;
mod model;
mod pki;

use anyhow::Result;
use clap::Parser;
use config::{Cli, Command, Mode};
use tracing_subscriber::EnvFilter;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("DRIFTWATCH_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls crypto provider");

    if let Err(e) = run(Cli::parse()).await {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

async fn run(mut cli: Cli) -> Result<()> {
    match cli.command.take().unwrap_or(Command::Serve) {
        Command::Serve => match cli.mode {
            Mode::Agent => agent::run(cli.agent).await,
            Mode::Control => control::run(cli.control).await,
        },
        Command::Invite { minutes } => control::invite_cli(cli.control, minutes),
        Command::Healthcheck => healthcheck(&cli).await,
        Command::Version => {
            println!("driftwatch {VERSION}");
            Ok(())
        }
    }
}

/// Used by the image's HEALTHCHECK (distroless has no curl): checks that the
/// server port accepts TCP connections.
async fn healthcheck(cli: &Cli) -> Result<()> {
    let addr = match cli.mode {
        Mode::Agent => cli.agent.listen,
        Mode::Control => cli.control.http_listen,
    };
    let target = if addr.ip().is_unspecified() {
        std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), addr.port())
    } else {
        addr
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(target),
    )
    .await??;
    Ok(())
}

/// Resolves on SIGINT or SIGTERM so `docker stop` shuts down promptly.
pub async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! {
        _ = ctrl_c => {},
        _ = term.recv() => {},
    }
    tracing::info!("shutting down");
}
