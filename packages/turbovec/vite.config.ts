import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "node build-turbovec.ts",
        // Only the crate decides the addon; cargo's own reads (target/, ~/.cargo) would make the
        // fingerprint huge and never match. A hit restores the addon without running cargo.
        input: ["src/**", "build.rs", "Cargo.toml", "Cargo.lock", "build-turbovec.ts"],
        output: ["memory-turbovec.node"],
        env: ["CARGO"],
      },
    },
  },
});
