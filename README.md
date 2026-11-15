# Driftwatch

Live Docker logs from every machine you own, in one web UI, without exposing a single port to the internet.

- **One binary, two roles.** The same image runs as an **agent** (next to Docker on each server) or as the **control** server (web UI and configuration).
- **Private by design.** Everything travels over Tailscale. Control and agents also authenticate each other with **mutual TLS** using a private CA that the control server runs.
- **Nothing stored on agents.** An agent is configured entirely through environment variables. Logs are streamed on demand and never stored centrally.
- **Passkeys only.** The web UI has no usernames or passwords.
- **Compose-aware.** Containers are grouped by compose project, and a whole project can be viewed as one merged, colour-tagged stream.
- **linux/amd64 and linux/arm64** images are built by GitHub Actions.

```
 Browser ──HTTPS (nginx on LAN, or Tailscale Serve)──▶ control ──mTLS over Tailscale──▶ agent ──▶ /var/run/docker.sock
   passkey session                      │  SQLite: CA, agents,             (no state, env only)
                                        │  passkeys, sessions
                                        └──▶ local /var/run/docker.sock  (optional)
```

The control server opens connections to the agents; agents never connect out. An agent therefore only needs to be reachable on your tailnet, and the control server is the only place that holds configuration.

## Security model

| Concern | How it is handled |
| --- | --- |
| Network exposure | Agents listen only inside a Tailscale sidecar's network namespace and publish nothing on the host. The UI is served either by your own HTTPS reverse proxy (published only on `127.0.0.1:8080` for it) or on the tailnet with Tailscale Serve. |
| Agent ⇄ control trust | TLS 1.3 mutual auth. The control server is a CA. Agent certificates carry `serverAuth` and the SAN `<id>.agent.driftwatch`; the control certificate carries `clientAuth` and `control.driftwatch`. |
| Stolen agent credentials | An agent certificate cannot connect to other agents (wrong key usage and SAN). The control server also **pins each agent's certificate fingerprint**, so *Reissue certificate* revokes the old one immediately. |
| Web UI auth | WebAuthn passkeys (discoverable credentials, user verification required). Sessions are `HttpOnly`, `SameSite=Strict`, `__Host-` cookies. State-changing requests must come from the UI's own origin. |
| First sign-in | `docker exec -it driftwatch driftwatch invite` prints a single-use link valid for 30 minutes. The command refuses to run unless it is attached to a terminal, so the link never lands in container logs. |
| Docker access | Agents only issue `GET` requests (list, inspect, logs). The socket is mounted read-only, but note that the Docker API itself is not read-only; use [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) with `DRIFTWATCH_DOCKER=tcp://socket-proxy:2375` if you want that enforced. |
| Secrets at rest | The control server's SQLite database (`/data/driftwatch.db`, mode 600) holds the CA key. Agent private keys are shown once and never stored by the control server. |

## Setup

### 1. Tailscale

In the [Tailscale admin console](https://login.tailscale.com/admin):

1. Enable **MagicDNS** (DNS page). Also enable **HTTPS certificates** if you want to serve the UI with Tailscale Serve instead of your own proxy.
2. Create an **auth key** (Settings → Keys). A reusable, tagged key is convenient for several machines.

### 2. Pull access to the image

The image is published to GitHub Container Registry as `ghcr.io/moudoux/driftwatch`. While the repository is private, log in once on each server with a personal access token that has the `read:packages` scope:

```sh
docker login ghcr.io -u Moudoux
```

### 3. Control server (e.g. the Raspberry Pi)

**Behind nginx on your LAN** (default, [deploy/control/compose.yaml](deploy/control/compose.yaml)):

```sh
mkdir driftwatch && cd driftwatch
# copy deploy/control/compose.yaml from this repo
echo "TS_AUTHKEY=tskey-auth-..." > .env
# set DRIFTWATCH_PUBLIC_URL in compose.yaml to the HTTPS URL nginx serves, e.g. https://logs.home.lan
docker compose up -d
docker exec -it driftwatch driftwatch invite
```

Then add an nginx site like [deploy/control/nginx.conf](deploy/control/nginx.conf). Things to know:

- **HTTPS is required.** Browsers only allow passkeys on HTTPS (or `localhost`), so `http://192.168.1.10` will not work. A certificate from a local CA, or from Let's Encrypt via a DNS challenge, is fine.
- **Passkeys are bound to the host name** in `DRIFTWATCH_PUBLIC_URL`, so always open the UI through that name.
- **Live streams are server-sent events.** Driftwatch sends `X-Accel-Buffering: no`, and the example config also turns off buffering and raises `proxy_read_timeout`.
- The UI port is published on `127.0.0.1:8080` of the Pi for nginx. If nginx runs in Docker, join the Tailscale container to nginx's network instead (see the comments in the compose file).

**Over Tailscale only**: use [deploy/control/compose.tailscale-serve.yaml](deploy/control/compose.tailscale-serve.yaml) with `DRIFTWATCH_PUBLIC_URL=https://driftwatch.<your-tailnet>.ts.net`. Tailscale Serve provides the HTTPS certificate.

Either way, Tailscale is what the control server uses to reach the agents. Open the link printed by `invite` and create your first passkey. Because `DRIFTWATCH_LOCAL=true`, the Pi's own containers appear right away, with no second container needed.

### 4. Agents

In the UI go to **Admin → Agents → Add agent**. You get a `compose.yaml` and a `.env` (or a single inlined file) containing a fresh certificate for that machine. Copy them to the server, add your `TS_AUTHKEY`, and run `docker compose up -d`. The machine turns green within a few seconds.

## Configuration

All settings are environment variables (each also has a `--flag`; see `driftwatch --help`).

| Variable | Mode | Default | Description |
| --- | --- | --- | --- |
| `DRIFTWATCH_MODE` | both | `agent` | `agent` or `control` |
| `DRIFTWATCH_LISTEN` | agent | `0.0.0.0:7443` | mTLS listen address |
| `DRIFTWATCH_CA`, `DRIFTWATCH_CERT`, `DRIFTWATCH_KEY` | agent | – | PEM or base64 of PEM, issued by the control server |
| `DRIFTWATCH_DOCKER` | agent | `/var/run/docker.sock` | Unix socket path, `unix://…` or `tcp://host:port` |
| `DRIFTWATCH_PUBLIC_URL` | control | `http://localhost:8080` | URL you open in the browser. Passkeys are bound to its host name, and it must be `https` unless it is `localhost` |
| `DRIFTWATCH_HTTP_LISTEN` | control | `0.0.0.0:8080` | Web UI / API listen address |
| `DRIFTWATCH_DATA_DIR` | control | `/data` | SQLite location |
| `DRIFTWATCH_LOCAL` | control | `false` | Also read the local Docker socket |
| `DRIFTWATCH_LOCAL_NAME` | control | Docker host name | Display name of the local machine |
| `DRIFTWATCH_LOCAL_DOCKER` | control | `/var/run/docker.sock` | Docker endpoint for local collection |
| `DRIFTWATCH_DNS` | control | – | DNS server for agent names, e.g. `100.100.100.100` for MagicDNS |
| `DRIFTWATCH_TAILNET` | control | from public URL | Tailnet suffix for short agent names, e.g. `tail1234.ts.net` |
| `DRIFTWATCH_IMAGE` | control | `ghcr.io/moudoux/driftwatch:latest` | Image used in generated snippets |
| `DRIFTWATCH_POLL_INTERVAL` | control | `10` | Seconds between agent status polls |
| `DRIFTWATCH_LOG` | both | `info` | Log filter, e.g. `debug` |

Short agent addresses such as `driftwatch-nas` are expanded with your tailnet domain, which is taken from `DRIFTWATCH_PUBLIC_URL` when that is a `*.ts.net` name. Behind nginx, set `DRIFTWATCH_TAILNET` (e.g. `tail1234.ts.net`) for that, or enter the agent's full `*.ts.net` name or its `100.x.y.z` address.

## Using the log viewer

- Click a container, or a compose project to merge all of its containers into one stream. Chips at the top show or hide individual containers.
- Press `/` to filter lines (matches are highlighted) and `Ctrl K` to filter the sidebar.
- Use the stdout/stderr toggle, timestamps, line wrap, pause, download and history size controls in the toolbar.
- Stopped and restarted containers show inline markers, and the stream resumes automatically. If an agent drops off, the stream reconnects and continues from the last line, without duplicates.
- ANSI colours are rendered. The newest 50,000 lines are kept in the browser.

## Development

Requirements: Rust (stable, 1.88 or newer), Node 24 and pnpm.

```sh
# UI
cd web && pnpm install && pnpm dev            # http://localhost:5173, proxies /api to :8080

# Control server against the dev UI (passkeys work on localhost)
DRIFTWATCH_MODE=control DRIFTWATCH_DATA_DIR=./dev-data \
DRIFTWATCH_PUBLIC_URL=http://localhost:5173 DRIFTWATCH_LOCAL=true \
cargo run

# Release build with the UI embedded
(cd web && pnpm build) && cargo build --release

cargo test && cargo clippy --all-targets
```

For a rootless Docker setup, point `DRIFTWATCH_LOCAL_DOCKER` / `DRIFTWATCH_DOCKER` at `unix:///run/user/$UID/docker.sock`.

### Layout

```
src/
  main.rs          CLI entry: serve | invite | healthcheck | version
  agent.rs         agent mTLS server
  docker.rs        read-only Docker API client and log decoder
  pki.rs           CA and certificate issuing, rustls configs
  control/
    mod.rs         control startup and state
    api.rs         JSON + SSE API
    auth.rs        sessions, invites, passkey ceremonies
    webauthn.rs    WebAuthn verification (ES256 / EdDSA / RS256)
    machines.rs    agent client, polling, resilient log streams
    db.rs          SQLite
    snippets.rs    generated compose files
web/               React + Vite + Tailwind UI (embedded into the binary)
deploy/            example compose files
```

## CI

- **CI** (`.github/workflows/ci.yml`): UI typecheck and build, `cargo fmt`, `clippy -D warnings` and tests.
- **Build & publish** (`.github/workflows/release.yml`): multi-arch image to GHCR on every push to `main` (`latest`, `sha-…`) and on `v*` tags (semver tags). Tags also create a GitHub release with `driftwatch-linux-amd64` / `-arm64` binaries. The Rust code is cross-compiled on the runner, so the arm64 build needs no emulation.
