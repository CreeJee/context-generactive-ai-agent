import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Context, Effect, Layer } from "effect";
import { ReportDelivery } from "memory-agent";
import { buildConfigLayer, type BuildServerConfig } from "./build-config.ts";

// Placeholder webhooks: the status only reveals the last four digits of the ID.
const embedded = "https://discord.com/api/webhooks/10000000000000001111/placeholder-token-embedded";
const runtime = "https://discord.com/api/webhooks/10000000000000002222/placeholder-token-runtime";

/** The report service as the agent runtime builds it: runtime environment, then build settings. */
const status = (environment: Record<string, string>, buildConfig: BuildServerConfig) =>
  Layer.build(
    ReportDelivery.layer().pipe(
      Layer.provide(buildConfigLayer(buildConfig)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: environment }))),
    ),
  ).pipe(
    Effect.flatMap((services) => Context.get(services, ReportDelivery).status),
    Effect.scoped,
  );

describe("build-time server settings", () => {
  it.effect("the embedded webhook reaches the report service's config", () =>
    Effect.gen(function* () {
      expect(yield* status({}, { DISCORD_WEBHOOK_URL: embedded })).toEqual({
        configured: true,
        webhookIdSuffix: "1111",
      });
    }),
  );

  it.effect("the runtime environment overrides the embedded webhook", () =>
    Effect.gen(function* () {
      expect(
        yield* status({ DISCORD_WEBHOOK_URL: runtime }, { DISCORD_WEBHOOK_URL: embedded }),
      ).toEqual({ configured: true, webhookIdSuffix: "2222" });
    }),
  );

  it.effect("without either the service stays unconfigured", () =>
    Effect.gen(function* () {
      expect(yield* status({}, {})).toEqual({ configured: false, webhookIdSuffix: null });
    }),
  );
});
