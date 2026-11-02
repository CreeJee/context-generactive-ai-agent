import type { AgentModelRuntime } from "../src/providers/contracts.ts";
import { Clock, Context, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import { GlobalConfig } from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { OAuthProfiles } from "../src/oauth/accounts.ts";
import { OAuthKeychain } from "../src/oauth/validation-harness.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { AccountSubscriptionProviderRegistry } from "../src/providers/subscriptions.ts";
import { createSubscriptionRuntimeImplementation } from "../src/providers/subscription-runtime.ts";
import { withOAuthTestPlatform, withTestPlatform } from "./support/platform.ts";

const selection = { provider: "openai", model: "gpt-5", reasoningEffort: "low" } as const;
/** A run's model, pinned until `release` or the test's scope ends. */
const pinned = Effect.fnUntraced(function* (runtime: AgentModelRuntime, runId: string) {
  const scope = yield* Scope.make();
  const release = Scope.close(scope, Exit.void);
  yield* Effect.addFinalizer(() => release);
  const { model } = yield* Scope.provide(
    runtime.model(selection, { threadId: "thread", runId, cacheRetention: "none" }),
    scope,
  );
  return { model, release };
});
/** Two signed-in local accounts; each one's access token is its name. */
const accounts = {
  first: "00000000-0000-4000-8000-000000000001",
  second: "00000000-0000-4000-8000-000000000002",
} as const;
const temporary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "subscription-dependencies-" });
}).pipe(withTestPlatform);

it.live(
  "native registry exports fresh account dependencies without selecting until a run's model is made",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: string[] = [];
        /** The provider's servers: each account's catalog window, and one streamed reply. */
        const fetch: typeof globalThis.fetch = (url, init) => {
          const authorization = new Headers(init?.headers).get("authorization")!;
          requests.push(authorization);
          return Promise.resolve(
            (url instanceof Request ? url.url : url.toString()).includes("/models")
              ? Response.json({
                  models: [
                    { slug: "gpt-5", context_window: authorization === "Bearer first" ? 111 : 222 },
                  ],
                })
              : new Response(
                  'data: {"type":"response.output_text.delta","delta":"reply"}\n\ndata: {"type":"response.completed"}\n\n',
                  { headers: { "content-type": "text/event-stream" } },
                ),
          );
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubGlobal("fetch", fetch)),
          () => Effect.sync(() => vi.unstubAllGlobals()),
        );
        const memory = yield* OAuthKeychain;
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.forEach(
          Object.entries(accounts),
          ([name, id]) =>
            Effect.flatMap(memory.profileStore(id), (store) =>
              store.write("openai", {
                accessToken: name,
                refreshToken: "fixture",
                expiresAt: now + 60_000,
              }),
            ),
          { discard: true },
        );
        const opened: string[] = [];
        const keychain = OAuthKeychain.of({
          store: memory.store,
          profileStore: (id) =>
            Effect.andThen(
              Effect.sync(() => opened.push(id)),
              memory.profileStore(id),
            ),
        });

        const storage = yield* temporary;
        const database = yield* Layer.build(Database.layer(":memory:"));
        const sql = Context.get(database, SqlClient.SqlClient);
        yield* sql`INSERT INTO oauth_profiles(id, provider, label, selected, created_at)
          VALUES (${accounts.first}, 'openai', 'first', 1, 0),
            (${accounts.second}, 'openai', 'second', 0, 1)`;
        const services = yield* Layer.build(
          AccountSubscriptionProviderRegistry.pipe(
            Layer.provideMerge(OAuthProfiles.layer),
            Layer.provide(Layer.succeedContext(database)),
            Layer.provide(GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)))),
            Layer.provide(Layer.succeed(OAuthKeychain, keychain)),
          ),
        );
        const registry = Context.get(services, ProviderRegistry);
        const profiles = Context.get(services, OAuthProfiles);

        const dependencies = yield* registry.subscriptionDependencies!("openai");
        expect(opened).toEqual([]);
        const provider = yield* registry.get("openai");
        const implementation = createSubscriptionRuntimeImplementation("openai");
        yield* provider.models.list;
        const oldRuntime = implementation.bind(dependencies);
        expect(oldRuntime.contextWindow("gpt-5")).toBe(111);
        const first = yield* pinned(oldRuntime, "run-0");
        yield* profiles.select("openai", accounts.second);
        expect(oldRuntime.contextWindowKnown?.("gpt-5")).toBe(false);
        yield* provider.models.list;
        const fresh = implementation.bind(yield* registry.subscriptionDependencies!("openai"));
        expect(fresh.contextWindow("gpt-5")).toBe(222);
        const second = yield* pinned(fresh, "run-1");
        const legacy = yield* pinned(yield* registry.runtime("openai"), "run-2");
        requests.length = 0;
        yield* Effect.forEach(
          [first, second, legacy],
          ({ model }) =>
            Effect.map(model.generateText({ prompt: "hello" }), (reply) =>
              expect(reply.text).toBe("reply"),
            ),
          { discard: true },
        );
        expect(requests).toEqual(["Bearer first", "Bearer second", "Bearer second"]);
        expect(yield* profiles.inUse("openai", accounts.first)).toBe(true);
        expect(yield* profiles.inUse("openai", accounts.second)).toBe(true);
        yield* first.release;
        yield* second.release;
        expect(yield* profiles.inUse("openai", accounts.first)).toBe(false);
        expect(yield* profiles.inUse("openai", accounts.second)).toBe(true);
        yield* legacy.release;
        expect(yield* profiles.inUse("openai", accounts.second)).toBe(false);
      }),
    ).pipe(withOAuthTestPlatform),
);
