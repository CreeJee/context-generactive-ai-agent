FROM rust:slim-bookworm AS rust
FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.4.1
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV PATH="/usr/local/cargo/bin:${PATH}" RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo RUSTUP_TOOLCHAIN=1.99.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && node packages/turbovec/build-turbovec.ts && cd tools/rrsi && pnpm exec vp pack
RUN chmod -R a+rX /app
USER node
ENTRYPOINT ["node", "packages/memory-agent/dist/rrsi-evaluator/rrsi-worker.mjs"]
