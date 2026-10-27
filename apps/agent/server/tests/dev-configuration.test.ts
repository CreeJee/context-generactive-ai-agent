import { NodeServices } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { Effect, Result } from "effect";
import { expect } from "vite-plus/test";
import { readDevConfiguration } from "../../scripts/dev-configuration.ts";

layer(NodeServices.layer)("development configuration", (it) => {
  it.effect("CLI overrides environment and separates connection manifests by backend port", () =>
    Effect.gen(function* () {
      const configuration = yield* readDevConfiguration(
        ["agent", "--backend-port", "5280", "--storage", "/tmp/dev-storage"],
        { CONTEXT_AGENT_DEV_BACKEND_PORT: "5180", CONTEXT_AGENT_DEV_WEB_PORT: "5273" },
        "/tmp/app",
      );
      expect(configuration).toMatchObject({
        mode: "agent",
        backendPort: 5280,
        webPort: 5273,
        storage: "/tmp/dev-storage",
        manifestFile: "/tmp/app/build/dev-backend-5280.json",
      });
      const web = yield* readDevConfiguration(["web", "--backend-port", "5280"], {}, "/tmp/app");
      expect(web.manifestFile).toBe(configuration.manifestFile);
      expect((yield* readDevConfiguration([], {}, "/tmp/app")).manifestFile).not.toBe(
        web.manifestFile,
      );
    }),
  );

  it.effect("collects spans locally unless turned off", () =>
    Effect.gen(function* () {
      const spans = (args: string[]) =>
        Effect.map(
          readDevConfiguration(args, {}, "/tmp/app"),
          (configuration) => configuration.spans,
        );
      expect(yield* spans([])).toEqual({
        kind: "local",
        port: 4318,
        file: "/tmp/app/build/dev-spans-5180.ndjson",
      });
      expect(yield* spans(["--otlp-port", "4400"])).toMatchObject({ kind: "local", port: 4400 });
      expect(yield* spans(["--no-otel"])).toEqual({ kind: "off" });
    }),
  );

  it.effect("invalid settings fail before starting either server", () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        [
          ["--backend-port", "NaN"],
          ["--web-port", "0"],
          ["--web-port", "65536"],
          ["--backend-port", "5173"],
          ["unknown-mode"],
          ["web", "extra"],
          ["--unknown"],
        ],
        (args) => Effect.result(readDevConfiguration(args, {}, "/tmp/app")),
      );
      expect(results.every(Result.isFailure)).toBe(true);
      const help = yield* readDevConfiguration(["--help"], {}, "/tmp/app");
      expect(help.help).toBe(true);
    }),
  );
});
