import { Effect } from "effect";
import {
  makeOpenAICompatibleSettings,
  OpenAICompatibleSettings,
  type OpenAICompatibleSettingsApi,
  type Settings,
} from "memory-agent";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { action, loader } from "../../routes/api/settings.compatible";

let testApi: OpenAICompatibleSettingsApi;
vi.mock("~/.server/agent", () => ({
  agent: {
    runPromise: (program: Effect.Effect<Response, unknown, OpenAICompatibleSettings>) =>
      Effect.runPromise(Effect.provideService(program, OpenAICompatibleSettings, testApi)),
  },
}));

beforeEach(() => {
  let saved: Settings = {};
  testApi = makeOpenAICompatibleSettings(
    {
      read: Effect.sync(() => saved),
      update: (patch) => Effect.sync(() => (saved = { ...saved, ...patch })),
    },
    { get: async () => null, set: async () => {} },
    async () => new Response("private upstream diagnostic", { status: 503 }),
  );
});

const post = (body: string, headers: Record<string, string> = {}) =>
  action({
    request: new Request("http://localhost/api/settings/compatible", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", ...headers },
    }),
  });

test("rejects cross-site and invalid JSON without invoking provider or leaking body", async () => {
  expect((await post("{}", { Origin: "https://attacker.example" })).status).toBe(403);
  const response = await post("{bad json");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_settings" });
});
test("returns a safe partial-save response without credential or provider details", async () => {
  testApi = makeOpenAICompatibleSettings(
    {
      read: Effect.succeed({}),
      update: () =>
        Effect.sync(() => {
          throw new Error("private config detail");
        }),
    },
    { get: async () => null, set: async () => {} },
  );
  const response = await post(
    JSON.stringify({
      action: "update",
      baseUrl: "http://localhost:1234/v1",
      model: "x",
      contextWindow: 8192,
      outputBudget: 512,
      toolCalling: false,
      apiKey: "private key value",
    }),
  );
  expect(response.status).toBe(409);
  const body = await response.text();
  expect(body).toBe('{"error":"settings_partially_saved"}');
  expect(body).not.toContain("private");
});
test("validates settings and isolates provider failures", async () => {
  const invalid = await post(
    JSON.stringify({
      action: "update",
      baseUrl: "file:///private",
      model: "x",
      contextWindow: 8192,
      outputBudget: 512,
      toolCalling: false,
    }),
  );
  expect(invalid.status).toBe(400);
  const saved = await post(
    JSON.stringify({
      action: "update",
      baseUrl: "http://localhost:1234/v1",
      model: "x",
      contextWindow: 8192,
      outputBudget: 512,
      toolCalling: false,
    }),
  );
  expect(saved.status).toBe(200);
  expect((await loader()).status).toBe(200);
  const failed = await post('{"action":"list"}');
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "provider_unavailable" });
});
