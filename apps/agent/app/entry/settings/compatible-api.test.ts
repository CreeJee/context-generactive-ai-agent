import { Cause, Effect, Schema } from "effect";
import {
  GlobalConfigFailed,
  makeOpenAICompatibleSettings,
  OpenAICompatibleSettings,
  type OpenAICompatibleSettingsApi,
  type Settings,
} from "memory-agent";
import { it } from "@effect/vitest";
import { beforeEach, expect } from "vite-plus/test";
import { makeCompatibleHandlers } from "../../.server/compatible-handlers";
let testApi: OpenAICompatibleSettingsApi;
const { action, loader } = makeCompatibleHandlers({
  runPromise: (program) =>
    Effect.runPromise(Effect.provideService(program, OpenAICompatibleSettings, testApi)),
});

beforeEach(() => {
  let saved: Settings = {};
  testApi = makeOpenAICompatibleSettings({
    config: {
      read: Effect.sync(() => saved),
      update: (patch) => Effect.sync(() => (saved = { ...saved, ...patch })),
    },
    keys: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
    fetcher: () => Promise.resolve(new Response("private upstream diagnostic", { status: 503 })),
  });
});

const call = <A>(execute: () => Promise<A>) =>
  Effect.tryPromise({ try: execute, catch: (cause) => new Cause.UnknownError(cause) });

const post = (body: string, headers: Record<string, string> = {}) =>
  action({
    request: new Request("http://localhost/api/settings/compatible", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", ...headers },
    }),
  });

it.effect("rejects cross-site and invalid JSON without invoking provider or leaking body", () =>
  Effect.gen(function* () {
    expect((yield* call(() => post("{}", { Origin: "https://attacker.example" }))).status).toBe(
      403,
    );
    const response = yield* call(() => post("{bad json"));
    expect(response.status).toBe(400);
    expect(yield* call(() => response.json())).toEqual({ error: "invalid_settings" });
  }),
);
it.effect("returns a safe partial-save response without credential or provider details", () =>
  Effect.gen(function* () {
    testApi = makeOpenAICompatibleSettings({
      config: {
        read: Effect.succeed({}),
        update: () =>
          Effect.fail(
            GlobalConfigFailed.make({
              operation: "write",
              reason: { _tag: "WriteFailed" },
              cause: new Error("private config detail"),
            }),
          ),
      },
      keys: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
    });
    const response = yield* Effect.flatMap(
      Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        action: "update",
        baseUrl: "http://localhost:1234/v1",
        model: "x",
        contextWindow: 8192,
        outputBudget: 512,
        toolCalling: false,
        apiKey: "private key value",
      }),
      (body) => call(() => post(body)),
    );
    expect(response.status).toBe(409);
    const body = yield* call(() => response.text());
    expect(body).toBe('{"error":"settings_partially_saved"}');
    expect(body).not.toContain("private");
  }),
);
it.effect("validates settings and isolates provider failures", () =>
  Effect.gen(function* () {
    const invalid = yield* Effect.flatMap(
      Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        action: "update",
        baseUrl: "file:///private",
        model: "x",
        contextWindow: 8192,
        outputBudget: 512,
        toolCalling: false,
      }),
      (body) => call(() => post(body)),
    );
    expect(invalid.status).toBe(400);
    const saved = yield* Effect.flatMap(
      Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        action: "update",
        baseUrl: "http://localhost:1234/v1",
        model: "x",
        contextWindow: 8192,
        outputBudget: 512,
        toolCalling: false,
      }),
      (body) => call(() => post(body)),
    );
    expect(saved.status).toBe(200);
    expect((yield* call(() => loader())).status).toBe(200);
    const failed = yield* call(() => post('{"action":"list"}'));
    expect(failed.status).toBe(502);
    expect(yield* call(() => failed.json())).toEqual({ error: "provider_unavailable" });
  }),
);
