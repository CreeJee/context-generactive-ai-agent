# syntax=docker/dockerfile:1
# Builds the executable that `pnpm build` makes for each Linux platform, and an image that runs it.
# The build stage follows Vite+'s Docker guide (node_modules/vite-plus/docs/guide/docker.md) plus Rust for turbovec.
# Each platform builds natively (or emulated): the executable embeds that platform's Node and native addons,
# so the stages must not cross-compile from $BUILDPLATFORM.
#   pnpm build:docker   linux/amd64 and linux/arm64 executables in apps/agent/dist/docker/context-agent-linux-<arch>/
#   pnpm start:docker   builds the image for this machine and runs it at http://localhost:5173
# To reach it from other machines, run the app with --broadcast and publish its port directly:
#   docker run -p 5173:5173 -v context-agent-data:/data context-agent --broadcast
# --broadcast has no authentication: anyone who can reach the port can use the app.
# Containers have no OS keychain, so secrets (API keys, OAuth tokens) are AES-GCM encrypted files in /data/secrets.
# Their key stays outside the volume: pass CONTEXT_AGENT_SECRET_KEY (`openssl rand -base64 32`) or a Docker secret
# via CONTEXT_AGENT_SECRET_KEY_FILE. Without it, saving a secret fails; losing it makes the stored secrets unreadable.

FROM rust:1.99.0-slim-bookworm AS rust

# --- build stage: the official Vite+ toolchain image (glibc; vp provisions Node from .node-version) ---
FROM ghcr.io/voidzero-dev/vite-plus:1.3.0 AS build
# Owned by the image's non-root `vp` user: cargo writes its git and registry caches here.
COPY --from=rust --chown=vp:vp /usr/local/cargo /usr/local/cargo
COPY --from=rust --chown=vp:vp /usr/local/rustup /usr/local/rustup
ENV PATH="/usr/local/cargo/bin:${PATH}" RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
WORKDIR /app
COPY --chown=vp:vp . .
# prepare scripts only patch editor/lint tooling and git hooks, which the build does not use.
RUN vp install --frozen-lockfile --ignore-scripts
RUN vp run build && mkdir /tmp/out && cp -R apps/agent/dist/context-agent-linux-* /tmp/out/

FROM scratch AS artifact
COPY --from=build /tmp/out/ /

# --- runtime stage: small glibc base, as Vite+ recommends; the executable and its addons link against glibc ---
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 ca-certificates socat tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home agent && mkdir /data /workspace && chown agent:agent /data /workspace
COPY --from=build /tmp/out/context-agent-linux-*/context-agent /usr/local/bin/context-agent
USER agent
ENV CONTEXT_AGENT_SECRET_DIRECTORY=/data/secrets
VOLUME ["/data"]
WORKDIR /workspace
# The app listens only on 127.0.0.1 and refuses non-loopback Host headers (DNS rebinding guard), so socat
# forwards the container port to it. Publish it on the host's loopback only: -p 127.0.0.1:5173:8080.
EXPOSE 8080
ENTRYPOINT ["tini", "--", "sh", "-c", "socat TCP-LISTEN:8080,fork,reuseaddr TCP:127.0.0.1:5173 & exec context-agent --no-open --storage /data \"$@\"", "context-agent"]
