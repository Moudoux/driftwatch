//! Compose snippets shown in the admin UI.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;

use super::db::AgentRow;
use crate::pki::Issued;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnippet {
    /// compose.yaml that reads secrets from a .env file.
    pub compose: String,
    /// The matching .env file.
    pub env: String,
    /// A single compose file with everything inlined.
    pub compose_inline: String,
    pub tailscale_hostname: String,
}

fn tailscale_hostname(row: &AgentRow) -> String {
    if row.address.parse::<std::net::IpAddr>().is_ok() {
        format!("driftwatch-{}", row.id)
    } else {
        row.address
            .split('.')
            .next()
            .unwrap_or(&row.address)
            .to_string()
    }
}

fn agent_compose(
    image: &str,
    row: &AgentRow,
    host: &str,
    ca: &str,
    cert: &str,
    key: &str,
    authkey: &str,
) -> String {
    format!(
        r#"# Driftwatch agent "{name}"
services:
  driftwatch-tailscale:
    image: tailscale/tailscale:latest
    hostname: {host}
    environment:
      TS_AUTHKEY: {authkey}
      TS_HOSTNAME: {host}
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
    volumes:
      - driftwatch-tailscale:/var/lib/tailscale
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - NET_ADMIN
    restart: unless-stopped

  driftwatch-agent:
    image: {image}
    network_mode: service:driftwatch-tailscale
    depends_on:
      - driftwatch-tailscale
    environment:
      DRIFTWATCH_MODE: agent
      DRIFTWATCH_LISTEN: 0.0.0.0:{port}
      DRIFTWATCH_CA: {ca}
      DRIFTWATCH_CERT: {cert}
      DRIFTWATCH_KEY: {key}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped

volumes:
  driftwatch-tailscale:
"#,
        name = row.name.replace('"', "'"),
        port = row.port,
    )
}

pub fn agent(image: &str, row: &AgentRow, issued: &Issued, ca_pem: &str) -> AgentSnippet {
    let host = tailscale_hostname(row);
    let ca = STANDARD.encode(ca_pem);
    let cert = STANDARD.encode(&issued.cert_pem);
    let key = STANDARD.encode(&issued.key_pem);
    let compose = agent_compose(
        image,
        row,
        &host,
        "${DRIFTWATCH_CA}",
        "${DRIFTWATCH_CERT}",
        "${DRIFTWATCH_KEY}",
        "${TS_AUTHKEY}",
    );
    let compose_inline = agent_compose(
        image,
        row,
        &host,
        &format!("\"{ca}\""),
        &format!("\"{cert}\""),
        &format!("\"{key}\""),
        "tskey-auth-REPLACE_ME",
    );
    let env = format!(
        "# Tailscale auth key: https://login.tailscale.com/admin/settings/keys\n\
         TS_AUTHKEY=tskey-auth-REPLACE_ME\n\
         # Issued by your Driftwatch control server. Keep this file private.\n\
         DRIFTWATCH_CA={ca}\n\
         DRIFTWATCH_CERT={cert}\n\
         DRIFTWATCH_KEY={key}\n"
    );
    AgentSnippet {
        compose,
        env,
        compose_inline,
        tailscale_hostname: host,
    }
}

/// Compose file for the control server. A `*.ts.net` public URL gets the
/// Tailscale Serve variant; anything else (e.g. nginx on the LAN) gets the
/// reverse-proxy variant.
pub fn control(image: &str, rp_id: &str, origin: &str) -> String {
    if rp_id.ends_with(".ts.net") {
        control_tailscale_serve(image, rp_id, origin)
    } else if rp_id == "localhost" {
        control_reverse_proxy(image, "https://logs.example.lan")
    } else {
        control_reverse_proxy(image, origin)
    }
}

fn control_reverse_proxy(image: &str, public: &str) -> String {
    format!(
        r#"# Driftwatch control server behind your own reverse proxy (e.g. nginx).
# Tailscale is only used to reach the agents on other machines.
services:
  tailscale:
    image: tailscale/tailscale:latest
    hostname: driftwatch
    environment:
      TS_AUTHKEY: ${{TS_AUTHKEY}}
      TS_HOSTNAME: driftwatch
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
    # driftwatch shares this container's network, so its port is published
    # here. nginx on the host proxies to http://127.0.0.1:8080.
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - tailscale-state:/var/lib/tailscale
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - NET_ADMIN
    restart: unless-stopped

  driftwatch:
    image: {image}
    network_mode: service:tailscale
    depends_on:
      - tailscale
    environment:
      DRIFTWATCH_MODE: control
      # The HTTPS URL nginx serves. Passkeys are bound to this host name.
      DRIFTWATCH_PUBLIC_URL: {public}
      DRIFTWATCH_HTTP_LISTEN: 0.0.0.0:8080
      DRIFTWATCH_LOCAL: "true"
      # Resolve agent names with MagicDNS; short names get this suffix.
      DRIFTWATCH_DNS: 100.100.100.100
      DRIFTWATCH_TAILNET: YOUR-TAILNET.ts.net
    volumes:
      - driftwatch-data:/data
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped

volumes:
  tailscale-state:
  driftwatch-data:
"#
    )
}

fn control_tailscale_serve(image: &str, rp_id: &str, public: &str) -> String {
    let host = rp_id.split('.').next().unwrap_or("driftwatch");
    format!(
        r#"# Driftwatch control server, served on your tailnet with Tailscale Serve.
services:
  tailscale:
    image: tailscale/tailscale:latest
    hostname: {host}
    environment:
      TS_AUTHKEY: ${{TS_AUTHKEY}}
      TS_HOSTNAME: {host}
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
      TS_SERVE_CONFIG: /config/serve.json
    configs:
      - source: tailscale-serve
        target: /config/serve.json
    volumes:
      - tailscale-state:/var/lib/tailscale
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - NET_ADMIN
    restart: unless-stopped

  driftwatch:
    image: {image}
    network_mode: service:tailscale
    depends_on:
      - tailscale
    environment:
      DRIFTWATCH_MODE: control
      DRIFTWATCH_PUBLIC_URL: {public}
      DRIFTWATCH_HTTP_LISTEN: 127.0.0.1:8080
      DRIFTWATCH_LOCAL: "true"
      DRIFTWATCH_DNS: 100.100.100.100
    volumes:
      - driftwatch-data:/data
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped

configs:
  tailscale-serve:
    content: |
      {{"TCP": {{"443": {{"HTTPS": true}}}},
       "Web": {{"$${{TS_CERT_DOMAIN}}:443": {{"Handlers": {{"/": {{"Proxy": "http://127.0.0.1:8080"}}}}}}}}}}

volumes:
  tailscale-state:
  driftwatch-data:
"#
    )
}
