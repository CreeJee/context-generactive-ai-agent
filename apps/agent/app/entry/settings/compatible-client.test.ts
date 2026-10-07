import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { makeCompatibleClient } from "./compatible-client.ts";

it.effect("validates compatible settings with the shared server schema", () =>
  Effect.gen(function* () {
    const client = makeCompatibleClient(() =>
      Promise.resolve(
        Response.json({
          configuration: {
            baseUrl: "http://localhost",
            model: "local",
            outputBudget: 256,
            toolCalling: true,
          },
          configured: true,
          hasApiKey: false,
        }),
      ),
    );
    const status = yield* client.effects.status();
    expect(status.configuration?.contextWindow).toBe(32_000);
    expect(status.configured).toBe(true);
    const malformed = makeCompatibleClient(() =>
      Promise.resolve(Response.json({ configured: "yes" })),
    );
    const failure = yield* Effect.flip(malformed.effects.status());
    expect(failure.reason._tag).toBe("InvalidResponse");
    expect(failure.operation).toBe("status");
  }),
);

it.effect("preserves partial-write guidance without reading a private failure body", () =>
  Effect.gen(function* () {
    const response = new Response("private error details", { status: 409 });
    response.json = () => {
      throw new Error("failure body must not be read");
    };
    const client = makeCompatibleClient(() => Promise.resolve(response));
    const failure = yield* Effect.flip(
      client.effects.update({
        baseUrl: "http://localhost",
        model: "local",
        contextWindow: 32_000,
        outputBudget: 256,
        toolCalling: true,
      }),
    );
    expect(failure.reason._tag).toBe("PartialWrite");
    expect(failure.operation).toBe("update");
    expect(failure.message).toContain("부분적으로 저장");
    expect(failure.message).not.toContain("private");
  }),
);

it.effect("update preserves an omitted key and sends null only for explicit removal", () =>
  Effect.gen(function* () {
    const requests: RequestInit[] = [];
    const configuration = {
      baseUrl: "http://localhost:8080/v1",
      model: "local-model",
      contextWindow: 32768,
      outputBudget: 4096,
      toolCalling: false,
    };
    const client = makeCompatibleClient((_url, init = {}) => {
      requests.push(init);
      return Promise.resolve(Response.json({ configuration, configured: true, hasApiKey: false }));
    });
    yield* client.effects.update(configuration);
    const decodeBody = Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    );
    expect(yield* decodeBody(requests[0]?.body)).toEqual({ action: "update", ...configuration });
    yield* client.effects.update({ ...configuration, apiKey: null });
    expect((yield* decodeBody(requests[1]?.body)).apiKey).toBeNull();
  }),
);

it.effect("test and optional catalog refresh use saved settings without sending credentials", () =>
  Effect.gen(function* () {
    const requests: RequestInit[] = [];
    const client = makeCompatibleClient((_url, init = {}) => {
      requests.push(init);
      return Promise.resolve(Response.json(requests.length === 1 ? { ok: true } : { models: [] }));
    });
    yield* client.effects.test();
    yield* client.effects.list();
    const decodeBody = Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    );
    expect(yield* Effect.forEach(requests, (request) => decodeBody(request.body))).toEqual([
      { action: "test" },
      { action: "list" },
    ]);
  }),
);

it.effect("does not expose upstream response bodies on failure", () =>
  Effect.gen(function* () {
    const response = new Response("secret upstream detail", { status: 502 });
    response.json = () => {
      throw new Error("failure body must not be read");
    };
    const client = makeCompatibleClient(() => Promise.resolve(response));
    const failure = yield* Effect.flip(client.effects.test());
    expect(failure.reason._tag).toBe("RequestRejected");
    expect(failure.message).toContain("502");
    expect(failure.message).not.toContain("secret");
  }),
);
