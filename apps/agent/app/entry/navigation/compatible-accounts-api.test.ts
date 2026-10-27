import { Cause, Effect } from "effect";
import {
  GlobalConfigFailed,
  makeOpenAICompatibleSettings,
  OpenAICompatibleSettings,
  type OpenAICompatibleSettingsApi,
  type Settings,
} from "memory-agent";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { compatibleAccountAction } from "../../.server/compatible-handlers";

const keys = () => ({ get: Effect.succeed(null), set: () => Effect.void });
const settingsWith = (overrides: Partial<Parameters<typeof makeOpenAICompatibleSettings>[0]>) => {
  let saved: Settings = {};
  return makeOpenAICompatibleSettings({
    config: {
      read: Effect.sync(() => saved),
      update: (patch) => Effect.sync(() => (saved = { ...saved, ...patch })),
    },
    keys,
    fetcher: () => Promise.resolve(new Response("private upstream diagnostic", { status: 503 })),
    ...overrides,
  });
};
const run = (
  api: OpenAICompatibleSettingsApi,
  command: Parameters<typeof compatibleAccountAction>[0],
) => Effect.provideService(compatibleAccountAction(command), OpenAICompatibleSettings, api);
const text = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new Cause.UnknownError(cause),
  });

it.effect("returns a safe partial-save response without credential or provider details", () =>
  Effect.gen(function* () {
    const api = settingsWith({
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
    const response = yield* run(api, {
      provider: "openai-compatible",
      intent: "create",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "private key value",
    });
    expect(response.status).toBe(409);
    const body = yield* text(response);
    expect(body).toBe('{"error":"settings_partially_saved"}');
    expect(body).not.toContain("private");
  }),
);

it.effect("validates endpoints and isolates provider failures", () =>
  Effect.gen(function* () {
    const api = settingsWith({});
    const invalid = yield* run(api, {
      provider: "openai-compatible",
      intent: "create",
      baseUrl: "file:///private",
    });
    expect(invalid.status).toBe(400);
    const created = yield* run(api, {
      provider: "openai-compatible",
      intent: "create",
      baseUrl: "http://localhost:1234/v1",
    });
    expect(created.status).toBe(200);
    const accountId = (yield* api.status).accounts[0]?.id ?? "";
    const missing = yield* run(api, {
      provider: "openai-compatible",
      intent: "select",
      accountId: "missing",
    });
    expect(missing.status).toBe(404);
    const failed = yield* run(api, {
      provider: "openai-compatible",
      intent: "discover",
      accountId,
    });
    expect(failed.status).toBe(502);
    expect(yield* text(failed)).toBe('{"error":"provider_unavailable"}');
  }),
);
