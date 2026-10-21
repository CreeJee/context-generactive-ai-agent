import { NodeServices } from "@effect/platform-node";
import { Effect, ManagedRuntime, Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { readDevConfiguration } from "../../scripts/dev-configuration.ts";

const runtime = ManagedRuntime.make(NodeServices.layer);

describe("development configuration", () => {
  test("CLI overrides environment and separates connection manifests by backend port", () => {
    const configuration = runtime.runSync(
      readDevConfiguration(
        ["agent", "--backend-port", "5280", "--storage", "/tmp/dev-storage"],
        { CONTEXT_AGENT_DEV_BACKEND_PORT: "5180", CONTEXT_AGENT_DEV_WEB_PORT: "5273" },
        "/tmp/app",
      ),
    );
    expect(configuration).toMatchObject({
      mode: "agent",
      backendPort: 5280,
      webPort: 5273,
      storage: "/tmp/dev-storage",
      manifestFile: "/tmp/app/build/dev-backend-5280.json",
    });
    const web = runtime.runSync(
      readDevConfiguration(["web", "--backend-port", "5280"], {}, "/tmp/app"),
    );
    expect(web.manifestFile).toBe(configuration.manifestFile);
    expect(runtime.runSync(readDevConfiguration([], {}, "/tmp/app")).manifestFile).not.toBe(
      web.manifestFile,
    );
  });

  test("collects spans locally unless turned off", () => {
    const spans = (args: string[]) =>
      runtime.runSync(readDevConfiguration(args, {}, "/tmp/app")).spans;
    expect(spans([])).toEqual({
      kind: "local",
      port: 4318,
      file: "/tmp/app/build/dev-spans-5180.ndjson",
    });
    expect(spans(["--otlp-port", "4400"])).toMatchObject({ kind: "local", port: 4400 });
    expect(spans(["--no-otel"])).toEqual({ kind: "off" });
  });

  test("invalid settings fail before starting either server", () => {
    for (const args of [
      ["--backend-port", "NaN"],
      ["--web-port", "0"],
      ["--web-port", "65536"],
      ["--backend-port", "5173"],
      ["unknown-mode"],
      ["web", "extra"],
      ["--unknown"],
    ]) {
      const result = runtime.runSync(Effect.result(readDevConfiguration(args, {}, "/tmp/app")));
      expect(Result.isFailure(result)).toBe(true);
    }
    const help = runtime.runSync(readDevConfiguration(["--help"], {}, "/tmp/app"));
    expect(help.help).toBe(true);
  });
});
