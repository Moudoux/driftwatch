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

pub fn control(image: &str, rp_id: &str) -> String {
    let host = rp_id.split('.').next().unwrap_or("driftwatch");
    let public = if rp_id == "localhost" {
        "https://driftwatch.YOUR-TAILNET.ts.net".to_string()
    } else {
        format!("https://{rp_id}")
    };
    format!(
        r#"# Driftwatch control server (also collects this machine's logs)
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
