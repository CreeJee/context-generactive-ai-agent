# Builds the Linux executable that `pnpm build` makes, for the Docker host's architecture.
# Run from the repository root:
#   docker build -f apps/agent/Dockerfile --target artifact --output type=local,dest=out .
# `out/context-agent-linux-<arch>/` then holds the executable and its .sha256.
FROM rust:1.99.0-slim-bookworm AS rust

FROM node:26.8.2-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.13.0
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV PATH="/usr/local/cargo/bin:${PATH}" RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
WORKDIR /app
COPY . .
# prepare scripts only patch editor/lint tooling and git hooks, which the build does not use.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build && mkdir /out && cp -R apps/agent/dist/context-agent-linux-* /out/

FROM scratch AS artifact
COPY --from=build /out/ /
