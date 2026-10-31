import { NodeCrypto } from "@effect/platform-node";
import { Crypto, Effect } from "effect";
import {
  GlobalConfigFailed,
  makeOpenAICompatibleSettings,
  OpenAICompatibleSettings,
  type OpenAICompatibleSettingsApi,
  type Settings,
} from "memory-agent";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { compatibleAccountAction } from "../../.server/compatible-handlers";

const keys = () => ({ get: Effect.succeed(null), set: () => Effect.void });
const settingsWith = Effect.fnUntraced(function* (
  overrides: Partial<Parameters<typeof makeOpenAICompatibleSettings>[0]>,
) {
  let saved: Settings = {};
  return makeOpenAICompatibleSettings({
    config: {
      read: Effect.sync(() => saved),
      update: (patch) => Effect.sync(() => (saved = { ...saved, ...patch })),
    },
    keys,
    crypto: yield* Crypto.Crypto,
    fetcher: () => Promise.resolve(new Response("private upstream diagnostic", { status: 503 })),
    ...overrides,
  });
});
const run = (
  api: OpenAICompatibleSettingsApi,
  command: Parameters<typeof compatibleAccountAction>[0],
) => Effect.provideService(compatibleAccountAction(command), OpenAICompatibleSettings, api);

layer(NodeCrypto.layer)((it) => {
  it.effect("refuses a partial save without credential or provider details", () =>
    Effect.gen(function* () {
      const api = yield* settingsWith({
        config: {
          read: Effect.succeed({}),
          update: () =>
            Effect.fail(
              GlobalConfigFailed.make({
                operation: "write",
                reason: GlobalConfigFailed.fields.reason.cases.WriteFailed.make({}),
                cause: new Error("private config detail"),
              }),
            ),
        },
      });
      const refused = yield* Effect.flip(
        run(api, {
          provider: "openai-compatible",
          intent: "create",
          baseUrl: "http://localhost:1234/v1",
          apiKey: "private key value",
        }),
      );
      expect(refused).toStrictEqual({ error: "settings_partially_saved" });
    }),
  );

  it.effect("validates endpoints and isolates provider failures", () =>
    Effect.gen(function* () {
      const api = yield* settingsWith({});
      const invalid = yield* Effect.flip(
        run(api, { provider: "openai-compatible", intent: "create", baseUrl: "file:///private" }),
      );
      expect(invalid).toStrictEqual({ error: "invalid_settings" });
      yield* run(api, {
        provider: "openai-compatible",
        intent: "create",
        baseUrl: "http://localhost:1234/v1",
      });
      const accountId = (yield* api.status).accounts[0]?.id ?? "";
      const missing = yield* Effect.flip(
        run(api, { provider: "openai-compatible", intent: "select", accountId: "missing" }),
      );
      expect(missing).toStrictEqual({ error: "account_not_found" });
      const failed = yield* Effect.flip(
        run(api, { provider: "openai-compatible", intent: "discover", accountId }),
      );
      expect(failed).toStrictEqual({ error: "endpoint_unavailable" });
    }),
  );
});
