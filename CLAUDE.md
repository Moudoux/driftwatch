# Driftwatch

Live Docker logs from many machines in one web UI. One Rust binary runs as an **agent** (next to Docker on each server) or as the **control** server (web UI, passkey auth, SQLite config). The React UI in `web/` is embedded into the binary at build time. See README.md for the user-facing docs.

## Commands

```sh
cargo build                                   # build.rs creates a placeholder web/dist if the UI isn't built
cargo test                                    # unit tests: docker log decoder, PKI, WebAuthn round trip, slugs
cargo clippy --all-targets --locked -- -D warnings   # CI fails on any warning
cargo fmt --check
(cd web && pnpm install && pnpm build)        # tsc -b + vite build -> web/dist (embedded by rust-embed)
(cd web && pnpm dev)                          # :5173, proxies /api to :8080
```

Run `pnpm build` before `cargo build --release` when the UI changed, or the binary embeds a stale/placeholder UI.

## Architecture

- `src/main.rs`: CLI (`serve` default, `invite`, `healthcheck`, `version`); all config is env vars in `src/config.rs` (`DRIFTWATCH_*`, each also a flag).
- `src/agent.rs`: mTLS server (`/v1/info`, `/v1/containers`, `/v1/logs` NDJSON). Only accepts client certs carrying the `control.driftwatch` SAN.
- `src/docker.rs`: read-only Docker Engine client over hyper (unix socket or tcp). `follow()` survives container restarts and resumes with `since`.
- `src/pki.rs`: the control server's CA (rcgen) and rustls configs. Agent certs: SAN `<id>.agent.driftwatch`, EKU serverAuth. Control cert: EKU clientAuth, regenerated on every start.
- `src/control/`: `mod.rs` startup/state, `api.rs` JSON + SSE routes, `auth.rs` sessions/invites/passkey ceremonies, `webauthn.rs` verification, `machines.rs` agent client + poller + reconnecting streams, `db.rs` SQLite, `snippets.rs` generated compose files, `assets.rs` embedded UI + security headers.
- `web/src/`: `App.tsx` (auth gate, 5 s machine polling), `components/LogViewer.tsx` (EventSource, virtualized list, filtering), `Sidebar.tsx`, `admin/*`, `lib/*`.

## Invariants (don't break these)

- **Agents are stateless**: env vars only, no files, no database.
- **The control server initiates every connection** to agents; agents never dial out.
- **All control ⇄ agent traffic is TLS 1.3 mutual auth.** The control server also pins each agent's certificate fingerprint (`agents.fingerprint`), so reissuing revokes the old cert.
- **Web auth is passkeys only.** No passwords or usernames. The first passkey comes from `driftwatch invite`, which must refuse non-TTY output so links never reach container logs.
- **Never print secrets to non-interactive output.** Agent private keys are shown once in the UI and never stored on the control server.
- State-changing API requests must pass the `Origin` check (`auth::origin_ok`). Cookies are `HttpOnly; SameSite=Strict` (`__Host-` prefix on https).
- WebAuthn RP id/origin come from `DRIFTWATCH_PUBLIC_URL`, which must be https unless it is localhost. The UI may sit behind nginx (default deploy) or Tailscale Serve.
- The log SSE stream sends `X-Accel-Buffering: no` for reverse proxies and ends with an `end` event so EventSource doesn't reconnect and replay.
- Container names, not ids, are used in UI routes, so compose-recreated containers keep their URL.
- Crypto stays pure Rust (ring + RustCrypto; no OpenSSL) so cross-compiling to arm64 stays simple.

## Dependencies

Several crates are newer majors than older training data: rcgen 0.14 (`Issuer`), rand 0.10 (`rand::fill`), p256 0.14 / ecdsa 0.17, ed25519-dalek 3, rsa 0.10 (`rsa::PublicKey`, `BoxedUint`, feature `pkcs1v15`), sha2 0.11, base64 0.23, axum 0.8 (`/{param}` routes), TypeScript 7, Vite 8, Tailwind 4, lucide-react 1.x. Read the source in `~/.cargo/registry/src/*/` before guessing an API.

## Testing end to end locally

This machine runs **rootless Docker** (`unix:///run/user/1000/docker.sock`) and has **no buildx**, so the Dockerfile can only be verified in GitHub Actions.

1. Start the control server with `DRIFTWATCH_MODE=control DRIFTWATCH_DATA_DIR=<scratch>/data DRIFTWATCH_HTTP_LISTEN=127.0.0.1:8080 DRIFTWATCH_LOCAL=true DRIFTWATCH_LOCAL_DOCKER=unix:///run/user/1000/docker.sock`.
2. Create an invite through a fake TTY: `script -qc "target/release/driftwatch invite" /dev/null` (same env).
3. `node scripts/e2e/authn.mjs http://localhost:8080 <inviteFile> <scratchDir>` registers a software passkey, signs in, and creates an agent. It writes `agent.env` and `cookie.txt` to the scratch dir; keep them out of the repo.
4. Start the agent with `agent.env` sourced, `DRIFTWATCH_MODE=agent DRIFTWATCH_LISTEN=127.0.0.1:7443` and the rootless socket.
5. `curl -N -H "Cookie: …" "localhost:8080/api/logs?machine=<id>&containers=<a,b>&tail=10"` to watch the stream.
6. `node scripts/e2e/shots.mjs <outDir> <cookieFile> "name|url|waitMs"` screenshots the UI with headless `google-chrome-stable`.

Stop test processes by PID: `pkill -f target/release/driftwatch` also matches the shell running it.

## Gotchas

- In Bash tool commands, compose's `$$` escaping inside heredocs trips the safety checker. Write such files with the Write/Edit tools.
- `docker exec -it driftwatch driftwatch invite` relies on `/usr/local/bin` being on PATH in the distroless image.
- GHCR image names must be lowercase: `ghcr.io/moudoux/driftwatch`.

## Repo conventions

- GitHub: private `Moudoux/driftwatch`. Commit with the repo-local noreply email that is already configured (`git config user.email`).
- CI: `.github/workflows/ci.yml` (UI build, fmt, clippy, tests); `release.yml` builds and pushes the amd64+arm64 image on `main` and `v*` tags (tags also attach binaries to a release).
