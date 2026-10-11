import { Cause } from "effect";
import { SubscriptionAccountProvider } from "../src/providers/contracts.ts";
import { DatabaseSync } from "node:sqlite";
import { Clock, Effect, FileSystem, Layer, Result, Schema, Stream } from "effect";
import { EventType } from "@tanstack/ai";
import { InternalLogger } from "@tanstack/ai/adapter-internals";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { GlobalConfig } from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { migrations } from "../src/db/migrations.ts";
import { createAccountBoundSubscriptionClients } from "../src/oauth/account-bound.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import { oauthProfileInUse } from "../src/oauth/run-leases.ts";
import { createSubscriptionOAuthClient } from "../src/oauth/subscription-oauth.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { createSubscriptionProvider } from "../src/providers/subscription-provider.ts";
import { SubscriptionProviderRegistry } from "../src/providers/subscriptions.ts";
import {
  createSubscriptionRuntime,
  createSubscriptionRuntimeImplementation,
} from "../src/providers/subscription-runtime.ts";
import { withTestPlatform } from "./support/platform.ts";

const logger = new InternalLogger(
  { debug() {}, info() {}, warn() {}, error() {} },
  {
    request: false,
    provider: false,
    output: false,
    middleware: false,
    tools: false,
    agentLoop: false,
    config: false,
    errors: false,
    sandbox: false,
  },
);
const selection = { provider: "openai", model: "gpt-5", reasoningEffort: "low" } as const;
const temporary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "subscription-dependencies-" });
}).pipe(withTestPlatform);

it.live(
  "native registry exports fresh account dependencies without selecting until adapter creation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const effectClock = yield* Clock.Clock;

        const storage = yield* temporary;
        const sqlite = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(":memory:")),
          (db) => Effect.sync(() => db.close()),
        );
        sqlite.exec(
          migrations
            .filter(
              (sql) =>
                sql.includes("CREATE TABLE oauth_profiles (") ||
                sql.includes("CREATE TABLE oauth_legacy_removed ("),
            )
            .join("\n"),
        );
        for (const [index, id] of ["first", "second"].entries())
          sqlite
            .prepare(
              "INSERT INTO oauth_profiles(id, provider, label, selected, created_at) VALUES (?, 'openai', ?, ?, ?)",
            )
            .run(id, id, index === 0 ? 1 : 0, index);
        const requests: string[] = [];
        const created: string[] = [];
        const clients = createAccountBoundSubscriptionClients({
          sqlite: sqlite,
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
            const first = oldRuntime.adapter(selection);
            yield* Effect.addFinalizer(() => Effect.sync(() => first.releaseRun?.()));
            sqlite.exec(
              "UPDATE oauth_profiles SET selected = CASE WHEN id = 'second' THEN 1 ELSE 0 END",
            );
            expect(oldRuntime.contextWindowKnown?.("gpt-5")).toBe(false);
            yield* provider.models.list;
            const fresh = implementation.bind(yield* registry.subscriptionDependencies!("openai"));
            expect(fresh.contextWindow("gpt-5")).toBe(222);
            const second = fresh.adapter(selection);
            const legacy = compatibility.adapter(selection);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                second.releaseRun?.();
                legacy.releaseRun?.();
              }),
            );
            requests.length = 0;
            for (const [index, adapter] of [first, second, legacy].entries()) {
              const chunks = yield* Stream.runCollect(
                Stream.fromAsyncIterable(
                  adapter.chatStream({
                    messages: [{ role: "user", content: "hello" }],
                    model: selection.model,
                    logger,
                    runId: `run-${index}`,
                    threadId: "thread",
                  }),
                  (cause) => new Cause.UnknownError(cause),
                ),
              );
              expect(chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(true);
            }
            expect(requests).toEqual(["Bearer first", "Bearer second", "Bearer second"]);
            expect(created).toEqual(["first", "second"]);
            expect(oauthProfileInUse(sqlite, "openai", "first")).toBe(true);
            expect(oauthProfileInUse(sqlite, "openai", "second")).toBe(true);
            first.releaseRun?.();
            second.releaseRun?.();
            expect(oauthProfileInUse(sqlite, "openai", "first")).toBe(false);
            expect(oauthProfileInUse(sqlite, "openai", "second")).toBe(true);
            legacy.releaseRun?.();
            expect(oauthProfileInUse(sqlite, "openai", "second")).toBe(false);
            const missing = yield* Effect.result(registry.subscriptionDependencies!("anthropic"));
            expect(Result.isFailure(missing) && missing.failure).toMatchObject({
              _tag: "ProviderUnavailable",
              provider: "anthropic",
            });
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
            expect(Result.isFailure(missing) && missing.failure).toMatchObject({
              _tag: "ProviderUnavailable",
              provider,
            });
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
