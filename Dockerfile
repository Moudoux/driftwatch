# syntax=docker/dockerfile:1.7
#
# Multi-arch image for linux/amd64 and linux/arm64. The Rust build always runs
# on the build machine's native architecture and cross-compiles, so building
# the arm64 image on an amd64 runner needs no emulation.

# ---- web UI ----
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /web
RUN npm install -g pnpm@12.20.0
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ---- Rust binary ----
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS build
ARG TARGETARCH
ARG BUILDARCH
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) triple=x86_64-unknown-linux-gnu; gcc=x86-64-linux-gnu ;; \
      arm64) triple=aarch64-unknown-linux-gnu; gcc=aarch64-linux-gnu ;; \
      *) echo "unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac; \
    echo "$triple" > /triple; \
    if [ "$TARGETARCH" != "$BUILDARCH" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends "gcc-$gcc" "libc6-dev-$TARGETARCH-cross"; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    rustup target add "$triple"
# Debian names its gcc by target triple, natively and when cross-compiling.
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
WORKDIR /src
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,id=driftwatch-target-$TARGETARCH \
    cargo build --release --locked --target "$(cat /triple)" \
    && cp "target/$(cat /triple)/release/driftwatch" /driftwatch

# ---- just the binary (used to attach binaries to GitHub releases) ----
FROM scratch AS binary
COPY --from=build /driftwatch /driftwatch

# ---- runtime ----
FROM gcr.io/distroless/cc-debian12 AS runtime
COPY --from=build /driftwatch /usr/local/bin/driftwatch
ENV DRIFTWATCH_DATA_DIR=/data
EXPOSE 7443 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/driftwatch", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/driftwatch"]
