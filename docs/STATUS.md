# Status

_Last updated: 2026-11-15_

## Done and verified locally

- Rust backend (agent + control) builds; `cargo test` (5 tests) and `clippy -D warnings` pass.
- Web UI builds (`tsc -b` + Vite) and was checked with headless Chrome screenshots: login, overview, merged compose-project log view, admin agents.
- End-to-end on one machine (control with local collection + one agent on 127.0.0.1:7443, rootless Docker):
  - Passkey registration via invite and sign-in with a software authenticator (`scripts/e2e/authn.mjs`); a used invite, a replayed assertion and cross-origin POSTs are rejected.
  - Live SSE stream through the agent: tail, stdout/stderr, ANSI, merged project view, container restart (`exited` → `running`, logs resume).
  - Killing and restarting the agent mid-stream: the stream reconnects and resumes with no lost or duplicated lines.
  - The agent rejects: no client cert, an agent cert used as a client cert (EKU), and a foreign self-signed cert.
  - Reissuing an agent cert makes the old one fail fingerprint pinning; restarting with the new env recovers.
  - Generated agent/control compose snippets pass `docker compose config`.
- nginx / LAN deployment: default `deploy/control/compose.yaml` publishes 127.0.0.1:8080 for a reverse proxy; `deploy/control/nginx.conf` example; SSE sends `X-Accel-Buffering: no`; `DRIFTWATCH_TAILNET` expands short agent names.

## Not verified yet

- **Dockerfile / multi-arch image**: no buildx locally, so it is first exercised by the `Build & publish` workflow on GitHub.
- **Real Tailscale deployment**: sidecar networking, MagicDNS resolution via `DRIFTWATCH_DNS=100.100.100.100`, and Tailscale Serve have not been run on real machines.
- **Real browser passkeys** (Touch ID / Windows Hello / phone): only the software authenticator was tested.
- **nginx in front of the UI**: the config example has not been run.

## Ideas / open items

- Optional: support several UI origins (e.g. LAN nginx *and* Tailscale) — passkeys are bound to a single RP id today.
- Optional: docker events stream instead of polling the container list every 10 s.
- Optional: light theme; regex filter in the log viewer.
