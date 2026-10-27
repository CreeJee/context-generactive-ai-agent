import { it } from "@effect/vitest";
import { MutableHashMap, DateTime, Effect, Exit, Scope } from "effect";
import { expect } from "vite-plus/test";
import { createSubscriptionOAuthClient } from "../src/oauth/subscription-oauth.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import { ModelUnavailable, type ModelRun } from "../src/providers/contracts.ts";
import { createSubscriptionRuntimeImplementation } from "../src/providers/subscription-runtime.ts";

const selection = { provider: "openai", model: "gpt-5", reasoningEffort: "low" } as const;
const runOf = (index: number): ModelRun => ({
  threadId: `thread-${index}`,
  runId: `run-${index}`,
  cacheRetention: "none",
});

it.effect("retained native implementation binds fresh central clients and pins each run", () =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context());
    const implementation = createSubscriptionRuntimeImplementation("openai");
    const routes = MutableHashMap.empty<string, string>();
    const requests: { auth: string | null; body: string }[] = [];
    const released: string[] = [];
    let credentialReads = 0;
    const nativeClient = (account: string) =>
      createSubscriptionOAuthClient({
        protocol: providerProtocols.openai,
        store: {
          read() {
            credentialReads++;
            return Promise.resolve({
              accessToken: account,
              refreshToken: "controlled-refresh",
              accountId: account,
              expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000,
            });
          },
          write() {
            return Promise.reject(new Error("unexpected credential refresh"));
          },
          remove() {
            return Promise.reject(new Error("unexpected credential removal"));
          },
        },
        fetch: (_url, init) =>
          run(
            Effect.gen(function* () {
              requests.push({
                auth: new Headers(init?.headers).get("authorization"),
                body: yield* Effect.promise(() => new Response(init?.body).text()),
              });
              return new Response(
                'data: {"type":"response.output_text.delta","delta":"native reply"}\n\ndata: {"type":"response.completed"}\n\n',
                {
                  headers: { "content-type": "text/event-stream" },
                },
              );
            }),
          ),
      });
    const centralClients = { first: nativeClient("first"), second: nativeClient("second") };
    let selected: keyof typeof centralClients = "first";
    let acquisitions = 0;
    const firstRuntime = implementation.bind({
      client: () => {
        const account = selected;
        const id = `run-${++acquisitions}`;
        MutableHashMap.set(routes, id, account);
        return {
          stream: centralClients[account].stream.bind(centralClients[account]),
          releaseRun: () => {
            MutableHashMap.remove(routes, id);
            released.push(id);
          },
        };
      },
      catalogWindow: () => 111,
    });
    const firstScope = yield* Scope.make();
    const first = yield* Scope.provide(firstRuntime.model(selection, runOf(0)), firstScope);
    selected = "second";
    const secondRuntime = implementation.bind({
      client: () => {
        acquisitions++;
        MutableHashMap.set(routes, "fresh-run", "second");
        return {
          stream: centralClients.second.stream.bind(centralClients.second),
          releaseRun: () => {
            MutableHashMap.remove(routes, "fresh-run");
            released.push("fresh-run");
          },
        };
      },
      catalogWindow: () => 222,
    });
    const secondScope = yield* Scope.make();
    const second = yield* Scope.provide(
      secondRuntime.model({ ...selection, reasoningEffort: "high" }, runOf(1)),
      secondScope,
    );
    expect(firstRuntime.contextWindow(selection.model)).toBe(111);
    expect(secondRuntime.contextWindow(selection.model)).toBe(222);
    for (const [index, { model }] of [first, second].entries())
      expect((yield* model.generateText({ prompt: `fresh-${index}` })).text).toBe("native reply");
    expect(requests.map((request) => request.auth)).toEqual(["Bearer first", "Bearer second"]);
    expect(requests[0]?.body).toContain("fresh-0");
    expect(requests[1]?.body).toContain("fresh-1");
    expect(credentialReads).toBe(2);
    expect(acquisitions).toBe(2);
    expect(MutableHashMap.size(routes)).toBe(2);
    yield* Scope.close(firstScope, Exit.void);
    expect([...routes]).toEqual([["fresh-run", "second"]]);
    yield* Scope.close(secondScope, Exit.void);
    expect(MutableHashMap.size(routes)).toBe(0);
    expect(released).toEqual(["run-1", "fresh-run"]);
    const anthropic = { ...selection, provider: "anthropic" } as const;
    expect(yield* Effect.flip(Effect.scoped(secondRuntime.model(anthropic, runOf(2))))).toEqual(
      ModelUnavailable.make(anthropic),
    );
    expect(acquisitions).toBe(2);
  }),
);
