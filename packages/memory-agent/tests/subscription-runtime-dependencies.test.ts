import {
  ProviderUnavailable,
  SubscriptionAccountProvider,
  type AgentModelRuntime,
} from "../src/providers/contracts.ts";
import { Clock, Context, Effect, Exit, FileSystem, Layer, Result, Schema, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { GlobalConfig } from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { createAccountBoundSubscriptionClients } from "../src/oauth/account-bound.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import { OAuthProfiles } from "../src/oauth/accounts.ts";
import { createSubscriptionOAuthClient } from "../src/oauth/subscription-oauth.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { createSubscriptionProvider } from "../src/providers/subscription-provider.ts";
import { SubscriptionProviderRegistry } from "../src/providers/subscriptions.ts";
import {
  createSubscriptionRuntime,
  createSubscriptionRuntimeImplementation,
} from "../src/providers/subscription-runtime.ts";
import { withTestPlatform } from "./support/platform.ts";

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
const temporary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "subscription-dependencies-" });
}).pipe(withTestPlatform);

it.live(
  "native registry exports fresh account dependencies without selecting until a run's model is made",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const effectClock = yield* Clock.Clock;

        const storage = yield* temporary;
        const database = yield* Layer.build(Database.layer(":memory:"));
        const sql = Context.get(database, SqlClient.SqlClient);
        yield* sql`INSERT INTO oauth_profiles(id, provider, label, selected, created_at)
          VALUES ('first', 'openai', 'first', 1, 0), ('second', 'openai', 'second', 0, 1)`;
        const profiles = Context.get(
          yield* Layer.build(
            OAuthProfiles.layer.pipe(Layer.provide(Layer.succeedContext(database))),
          ),
          OAuthProfiles,
        );
        const requests: string[] = [];
        const created: string[] = [];
        const clients = createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: (id) => {
            created.push(id!);
            return createSubscriptionOAuthClient({
              protocol: providerProtocols.openai,
              store: {
                read: () =>
                  Promise.resolve({
                    accessToken: id!,
                    refreshToken: "fixture",
                    expiresAt: effectClock.currentTimeMillisUnsafe() + 60_000,
                  }),
                write: () => Promise.reject(new Error("unexpected refresh")),
                remove: () => Promise.reject(new Error("unexpected removal")),
              },
              fetch: (url, init) => {
                requests.push(new Headers(init?.headers).get("authorization")!);
                return Promise.resolve(
                  (url instanceof Request ? url.url : url.toString()).includes("/models")
                    ? Response.json({
                        models: [{ slug: "gpt-5", context_window: id === "first" ? 111 : 222 }],
                      })
                    : new Response(
                        'data: {"type":"response.output_text.delta","delta":"reply"}\n\ndata: {"type":"response.completed"}\n\n',
                        { headers: { "content-type": "text/event-stream" } },
                      ),
                );
              },
            });
          },
          accounts: {
            read: () => Promise.resolve(null),
            write: () => Promise.reject(new Error("unexpected profile write")),
            remove: () => Promise.reject(new Error("unexpected profile removal")),
          },
        });
        const program = Effect.gen(function* () {
          const config = yield* GlobalConfig;
          const provider = createSubscriptionProvider({
            protocol: providerProtocols.openai,
            config,
            client: clients.client,
            catalogKey: clients.catalogKey,
          });
          const compatibility = createSubscriptionRuntime(
            "openai",
            clients.forRun,
            provider.contextWindow,
          );
          const resolver = () =>
            Effect.succeed({ client: clients.forRun, catalogWindow: provider.contextWindow });
          const verification = Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            expect(yield* registry.runtime("openai")).toBe(compatibility);
            const dependencies = yield* registry.subscriptionDependencies!("openai");
            expect(dependencies.client).toBe(clients.forRun);
            expect(dependencies.catalogWindow).toBe(provider.contextWindow);
            expect(created).toEqual([]);
            const implementation = createSubscriptionRuntimeImplementation("openai");
            yield* provider.models.list;
            const oldRuntime = implementation.bind(dependencies);
            expect(oldRuntime.contextWindow("gpt-5")).toBe(111);
            const first = yield* pinned(oldRuntime, "run-0");
            yield* profiles.select("openai", "second", {
              read: () =>
                Promise.resolve({ accessToken: "second", refreshToken: "fixture", expiresAt: 0 }),
              write: () => Promise.reject(new Error("unexpected profile write")),
              remove: () => Promise.reject(new Error("unexpected profile removal")),
            });
            expect(oldRuntime.contextWindowKnown?.("gpt-5")).toBe(false);
            yield* provider.models.list;
            const fresh = implementation.bind(yield* registry.subscriptionDependencies!("openai"));
            expect(fresh.contextWindow("gpt-5")).toBe(222);
            const second = yield* pinned(fresh, "run-1");
            const legacy = yield* pinned(compatibility, "run-2");
            requests.length = 0;
            for (const { model } of [first, second, legacy])
              expect((yield* model.generateText({ prompt: "hello" })).text).toBe("reply");
            expect(requests).toEqual(["Bearer first", "Bearer second", "Bearer second"]);
            expect(created).toEqual(["first", "second"]);
            expect(profiles.inUse("openai", "first")).toBe(true);
            expect(profiles.inUse("openai", "second")).toBe(true);
            yield* first.release;
            yield* second.release;
            expect(profiles.inUse("openai", "first")).toBe(false);
            expect(profiles.inUse("openai", "second")).toBe(true);
            yield* legacy.release;
            expect(profiles.inUse("openai", "second")).toBe(false);
            const missing = yield* Effect.result(registry.subscriptionDependencies!("anthropic"));
            expect(Result.isFailure(missing) && missing.failure).toEqual(
              ProviderUnavailable.make({ provider: "anthropic" }),
            );
          });
          yield* verification.pipe(
            // Test entry point owns this Layer and its resource scope.
            Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
              const services = yield* Layer.build(
                ProviderRegistry.layer([provider], [compatibility], resolver),
              );
              return yield* Effect.provideContext(program, services);
            }, Effect.scoped),
          );
        });
        yield* program.pipe(
          // Test entry point owns this Layer and its resource scope.
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(
              GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage))),
            );
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        );
      }),
    ),
);

it.live(
  "default layer stays unavailable and native subscription layer exports without auth IO",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unavailable = Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          expect(registry.providers).toEqual([]);
          for (const provider of ["openai", "anthropic"] as const) {
            const missing = yield* Effect.result(registry.subscriptionDependencies!(provider));
            expect(Result.isFailure(missing) && missing.failure).toEqual(
              ProviderUnavailable.make({ provider }),
            );
          }
        });
        // Test entry point owns this Layer and its resource scope.
        yield* unavailable.pipe(
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(ProviderRegistry.layer([]));
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        );
        const storage = yield* temporary;
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          for (const provider of registry.providers) {
            if (!Schema.is(SubscriptionAccountProvider)(provider)) continue;
            const dependencies = yield* registry.subscriptionDependencies!(provider);
            const runtime = yield* registry.runtime(provider);
            expect(
              createSubscriptionRuntimeImplementation(provider)
                .bind(dependencies)
                .contextWindow("unknown"),
            ).toBe(runtime.contextWindow("unknown"));
          }
        }).pipe(
          // Test entry point owns this Layer and its resource scope.
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(
              SubscriptionProviderRegistry.pipe(
                Layer.provide(GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)))),
              ),
            );
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        );
      }),
    ),
);
