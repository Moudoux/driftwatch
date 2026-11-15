//! Control mode: web UI, passkey auth, agent management and log fan-in.

mod api;
mod assets;
mod auth;
mod db;
mod machines;
mod snippets;
mod webauthn;

use std::io::IsTerminal;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::Router;
use url::Url;

use crate::config::ControlConfig;
use crate::docker::Docker;
use crate::pki::{self, Ca};
use db::Db;
use machines::{Machine, Registry};

pub struct AppState {
    pub cfg: ControlConfig,
    pub db: Db,
    pub ca: Ca,
    pub tls: Arc<rustls::ClientConfig>,
    pub registry: Arc<Registry>,
    pub rp: webauthn::RelyingParty,
    pub secure_cookies: bool,
    pub search_domain: Option<String>,
    pub challenges: auth::Challenges,
    pub local: Option<Docker>,
}

pub type App = Arc<AppState>;

struct PublicUrl {
    origin: String,
    host: String,
    https: bool,
}

fn parse_public_url(raw: &str) -> Result<PublicUrl> {
    let url =
        Url::parse(raw).with_context(|| format!("DRIFTWATCH_PUBLIC_URL is not a URL: {raw}"))?;
    let host = url
        .host_str()
        .context("DRIFTWATCH_PUBLIC_URL has no host")?
        .to_string();
    let https = url.scheme() == "https";
    if !https && host != "localhost" {
        bail!("DRIFTWATCH_PUBLIC_URL must use https (passkeys only work on https or localhost)");
    }
    Ok(PublicUrl {
        origin: url.origin().ascii_serialization(),
        host,
        https,
    })
}

fn open_db(cfg: &ControlConfig) -> Result<Db> {
    Db::open(&cfg.data_dir.join("driftwatch.db"))
}

fn load_or_create_ca(db: &Db) -> Result<Ca> {
    match (db.meta_get("ca_cert")?, db.meta_get("ca_key")?) {
        (Some(c), Some(k)) => Ca::load(&c, &k),
        _ => {
            tracing::info!("creating a new certificate authority");
            let (c, k) = Ca::generate()?;
            db.meta_set("ca_cert", &c)?;
            db.meta_set("ca_key", &k)?;
            Ca::load(&c, &k)
        }
    }
}

impl AppState {
    /// Rebuilds the machine list from the database.
    pub async fn reload_machines(&self) -> Result<()> {
        let mut list = Vec::new();
        if let Some(docker) = &self.local {
            let name = match &self.cfg.local_name {
                Some(n) => n.clone(),
                None => docker
                    .info()
                    .await
                    .map(|i| i.hostname)
                    .unwrap_or_else(|_| "This machine".into()),
            };
            list.push(Machine::local(name, docker.clone()));
        }
        for row in self.db.agents()? {
            list.push(Machine::remote(
                &row,
                self.tls.clone(),
                self.cfg.dns,
                self.search_domain.clone(),
            ));
        }
        self.registry.set_machines(list).await;
        Ok(())
    }
}

pub async fn run(cfg: ControlConfig) -> Result<()> {
    let public = parse_public_url(&cfg.public_url)?;
    let db = open_db(&cfg)?;
    let ca = load_or_create_ca(&db)?;
    // A fresh client certificate on every start; agents trust anything the CA
    // signed with the control identity.
    let control = ca.issue_control()?;
    let tls = pki::client_config(&ca.cert_pem, &control.cert_pem, &control.key_pem)?;

    if db.meta_get("user_handle")?.is_none() {
        let mut h = [0u8; 16];
        rand::fill(&mut h);
        db.meta_set("user_handle", &webauthn::b64(&h))?;
    }

    let search_domain = public
        .host
        .strip_suffix(".ts.net")
        .and_then(|rest| rest.split_once('.'))
        .map(|(_, tailnet)| format!("{tailnet}.ts.net"));

    let state = Arc::new(AppState {
        rp: webauthn::RelyingParty {
            id: public.host.clone(),
            origin: public.origin.clone(),
            name: "Driftwatch".into(),
        },
        secure_cookies: public.https,
        search_domain,
        challenges: Default::default(),
        local: cfg.local.then(|| Docker::new(&cfg.local_docker)),
        registry: Arc::new(Registry::default()),
        db,
        ca,
        tls,
        cfg: cfg.clone(),
    });
    state.reload_machines().await?;
    tokio::spawn(
        state
            .registry
            .clone()
            .run_poller(Duration::from_secs(cfg.poll_interval.max(2))),
    );

    if state.db.passkey_count()? == 0 {
        tracing::info!(
            "no passkeys registered yet; create a sign-up link with: docker exec -it <container> driftwatch invite"
        );
    }

    let app: Router = Router::new()
        .nest("/api", api::router(state.clone()))
        .fallback(assets::serve)
        .layer(axum::middleware::from_fn(assets::security_headers));

    let listener = tokio::net::TcpListener::bind(cfg.http_listen)
        .await
        .with_context(|| format!("bind {}", cfg.http_listen))?;
    tracing::info!(
        "control server listening on {} (public URL {})",
        cfg.http_listen,
        public.origin
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(crate::shutdown_signal())
        .await?;
    Ok(())
}

/// `driftwatch invite`: prints a one-time passkey registration link.
pub fn invite_cli(cfg: ControlConfig, minutes: u32) -> Result<()> {
    if !std::io::stdout().is_terminal() {
        bail!(
            "refusing to print an invite link to a non-interactive output; run this with `docker exec -it`"
        );
    }
    let public = parse_public_url(&cfg.public_url)?;
    let db = open_db(&cfg)?;
    let (token, expires) = auth::create_invite(&db, i64::from(minutes.clamp(1, 24 * 60)) * 60)?;
    let expires = time::OffsetDateTime::from_unix_timestamp(expires)?;
    println!();
    println!(
        "  Open this link to register a passkey (single use, expires {} UTC):",
        expires.time()
    );
    println!();
    println!("  {}/#/invite/{token}", public.origin);
    println!();
    Ok(())
}
