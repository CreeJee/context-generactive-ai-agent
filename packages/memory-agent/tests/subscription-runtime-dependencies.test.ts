import {
  ProviderUnavailable,
  SubscriptionAccountProvider,
  type AgentModelRuntime,
} from "../src/providers/contracts.ts";
import {
  Clock,
  Context,
  type Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Result,
  Schema,
  Scope,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
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
const temporary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "subscription-dependencies-" });
}).pipe(withTestPlatform);

it.live(
  "native registry exports fresh account dependencies without selecting until a run's model is made",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const platform = yield* Effect.context<
          Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
        >();

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
        const clients = yield* createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: (id) =>
            Effect.suspend(() => {
              created.push(id!);
              return createSubscriptionOAuthClient({
                protocol: providerProtocols.openai,
                store: {
                  read: () =>
                    Effect.map(Clock.currentTimeMillis, (now) => ({
                      accessToken: id!,
                      refreshToken: "fixture",
                      expiresAt: now + 60_000,
                    })),
                  write: () => Effect.die("unexpected refresh"),
                  remove: () => Effect.die("unexpected removal"),
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
              }).pipe(Effect.provideContext(platform));
            }),
          accounts: {
            read: () => Effect.succeed(null),
            write: () => Effect.die("unexpected profile write"),
            remove: () => Effect.die("unexpected profile removal"),
          },
        });
        const program = Effect.gen(function* () {
          const config = yield* GlobalConfig;
          const provider = yield* createSubscriptionProvider({
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
                Effect.succeed({ accessToken: "second", refreshToken: "fixture", expiresAt: 0 }),
              write: () => Effect.die("unexpected profile write"),
              remove: () => Effect.die("unexpected profile removal"),
            });
            expect(oldRuntime.contextWindowKnown?.("gpt-5")).toBe(false);
            yield* provider.models.list;
            const fresh = implementation.bind(yield* registry.subscriptionDependencies!("openai"));
            expect(fresh.contextWindow("gpt-5")).toBe(222);
            const second = yield* pinned(fresh, "run-1");
            const legacy = yield* pinned(compatibility, "run-2");
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
            expect(created).toEqual(["first", "second"]);
            expect(yield* profiles.inUse("openai", "first")).toBe(true);
            expect(yield* profiles.inUse("openai", "second")).toBe(true);
            yield* first.release;
            yield* second.release;
            expect(yield* profiles.inUse("openai", "first")).toBe(false);
            expect(yield* profiles.inUse("openai", "second")).toBe(true);
            yield* legacy.release;
            expect(yield* profiles.inUse("openai", "second")).toBe(false);
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
    ).pipe(withOAuthTestPlatform),
);

it.live(
  "default layer stays unavailable and native subscription layer exports without auth IO",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unavailable = Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          expect(registry.providers).toEqual([]);
          yield* Effect.forEach(
            ["openai", "anthropic"] as const,
            (provider) =>
              Effect.map(Effect.result(registry.subscriptionDependencies!(provider)), (missing) =>
                expect(Result.isFailure(missing) && missing.failure).toEqual(
                  ProviderUnavailable.make({ provider }),
                ),
              ),
            { discard: true },
          );
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
          yield* Effect.forEach(
            registry.providers.filter(Schema.is(SubscriptionAccountProvider)),
            Effect.fnUntraced(function* (provider) {
              const dependencies = yield* registry.subscriptionDependencies!(provider);
              const runtime = yield* registry.runtime(provider);
              expect(
                createSubscriptionRuntimeImplementation(provider)
                  .bind(dependencies)
                  .contextWindow("unknown"),
              ).toBe(runtime.contextWindow("unknown"));
            }),
            { discard: true },
          );
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
    ).pipe(withOAuthTestPlatform),
);
