import { it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  CompatibleAccountsView,
  CompatibleRequestFailedReason,
  makeCompatibleClient,
} from "./compatible-client.ts";

const reasons = CompatibleRequestFailedReason.cases;
/** A subscription provider's `/api/accounts` body, which the compatible client refuses. */
type SubscriptionView = Data.TaggedEnum<{ subscription: { readonly profiles: readonly [] } }>;
const SubscriptionView = Data.taggedEnum<SubscriptionView>();

const decodeBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

it.effect("validates the endpoint list with the shared server schema", () =>
  Effect.gen(function* () {
    const client = makeCompatibleClient(() =>
      Promise.resolve(
        Response.json({
          // Encoded as the server sends it, before decoding fills the model's context window.
          ...CompatibleAccountsView.make({ accounts: [] }),
          accounts: [
            {
              id: "a",
              label: "local",
              baseUrl: "http://localhost",
              models: [{ id: "local", outputBudget: 256, toolCalling: true }],
              hasApiKey: false,
              selected: true,
            },
          ],
        }),
      ),
    );
    const view = yield* client.effects.list();
    expect(view.accounts[0]?.models[0]?.contextWindow).toBe(32_000);
    const malformed = makeCompatibleClient(() =>
      Promise.resolve(Response.json(SubscriptionView.subscription({ profiles: [] }))),
    );
    const failure = yield* Effect.flip(malformed.effects.list());
    expect(failure.reason).toEqual(reasons.InvalidResponse.make({}));
    expect(failure.operation).toBe("list");
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
      client.effects.change({ intent: "create", baseUrl: "http://localhost" }),
    );
    expect(failure.reason).toEqual(reasons.PartialWrite.make({}));
    expect(failure.operation).toBe("create");
    expect(failure.message).toContain("부분적으로 저장");
    expect(failure.message).not.toContain("private");
  }),
);

it.effect("connect preserves an omitted key and sends null only for explicit removal", () =>
  Effect.gen(function* () {
    const requests: RequestInit[] = [];
    const client = makeCompatibleClient((_url, init = {}) => {
      requests.push(init);
      return Promise.resolve(Response.json(CompatibleAccountsView.make({ accounts: [] })));
    });
    const connection = {
      intent: "connect",
      accountId: "a",
      baseUrl: "http://localhost/v1",
    } as const;
    yield* client.effects.change(connection);
    expect(yield* decodeBody(requests[0]?.body)).toEqual({
      provider: "openai-compatible",
      ...connection,
    });
    yield* client.effects.change({ ...connection, apiKey: null });
    expect((yield* decodeBody(requests[1]?.body)).apiKey).toBeNull();
  }),
);

it.effect("does not expose upstream response bodies on failure", () =>
  Effect.gen(function* () {
    const response = new Response("secret upstream detail", { status: 502 });
    response.json = () => {
      throw new Error("failure body must not be read");
    };
    const client = makeCompatibleClient(() => Promise.resolve(response));
    const failure = yield* Effect.flip(client.effects.test("a", "local"));
    expect(failure.reason).toEqual(reasons.RequestRejected.make({}));
    expect(failure.message).toContain("502");
    expect(failure.message).not.toContain("secret");
  }),
);
