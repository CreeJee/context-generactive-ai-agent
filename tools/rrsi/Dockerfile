FROM rust:slim-bookworm AS rust
FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.4.1
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV PATH="/usr/local/cargo/bin:${PATH}" RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo RUSTUP_TOOLCHAIN=1.99.0
WORKDIR /app
COPY . .
# prepare scripts only patch editor/lint tooling, and the root and memory-agent copies race here.
RUN pnpm install --frozen-lockfile --ignore-scripts && node packages/turbovec/build-turbovec.ts && node packages/memory-agent/scripts/build-runtime-artifacts.ts && cd tools/rrsi && pnpm exec vp pack
RUN chmod -R a+rX /app
# A new anonymous volume copies this directory's owner, so the worker can write its storage copy.
RUN mkdir /work && chown node:node /work
USER node
ENTRYPOINT ["node", "--conditions=rrsi-evaluator", "packages/memory-agent/dist/rrsi-evaluator/rrsi-worker.mjs"]
