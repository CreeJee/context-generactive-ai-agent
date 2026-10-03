import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Result } from "effect";
import { EventType } from "@tanstack/ai";
import { InternalLogger } from "@tanstack/ai/adapter-internals";
import { expect, test } from "vite-plus/test";
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
const temporary = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "subscription-dependencies-"))),
  (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
);

test("native registry exports fresh account dependencies without selecting until adapter creation", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
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
        const clients = createAccountBoundSubscriptionClients(
          sqlite,
          "openai",
          (id) => {
            created.push(id!);
            return createSubscriptionOAuthClient({
              protocol: providerProtocols.openai,
              store: {
                read: async () => ({
                  accessToken: id!,
                  refreshToken: "fixture",
                  expiresAt: Date.now() + 60_000,
                }),
                write: async () => {
                  throw new Error("unexpected refresh");
                },
                remove: async () => {
                  throw new Error("unexpected removal");
                },
              },
              fetch: async (url, init) => {
                requests.push(new Headers(init?.headers).get("authorization")!);
                return (url instanceof Request ? url.url : url.toString()).includes("/models")
                  ? Response.json({
                      models: [{ slug: "gpt-5", context_window: id === "first" ? 111 : 222 }],
                    })
                  : new Response(
                      'data: {"type":"response.output_text.delta","delta":"reply"}\n\ndata: {"type":"response.completed"}\n\n',
                      { headers: { "content-type": "text/event-stream" } },
                    );
              },
            });
          },
          {
            read: async () => null,
            write: async () => {
              throw new Error("unexpected profile write");
            },
            remove: async () => {
              throw new Error("unexpected profile removal");
            },
          },
        );
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
              const chunks = yield* Effect.promise(async () => {
                const output = [];
                for await (const chunk of adapter.chatStream({
                  messages: [{ role: "user", content: "hello" }],
                  model: selection.model,
                  logger,
                  runId: `run-${index}`,
                  threadId: "thread",
                }))
                  output.push(chunk);
                return output;
              });
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
            Effect.provide(ProviderRegistry.layer([provider], [compatibility], resolver)),
          );
        });
        yield* program.pipe(
          Effect.provide(GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)))),
        );
      }),
    ),
  ));

test("default layer stays unavailable and native subscription layer exports without auth IO", () =>
  Effect.runPromise(
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
        yield* unavailable.pipe(Effect.provide(ProviderRegistry.layer([])));
        const storage = yield* temporary;
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          for (const provider of registry.providers) {
            const dependencies = yield* registry.subscriptionDependencies!(provider);
            const runtime = yield* registry.runtime(provider);
            expect(
              createSubscriptionRuntimeImplementation(provider)
                .bind(dependencies)
                .contextWindow("unknown"),
            ).toBe(runtime.contextWindow("unknown"));
          }
        }).pipe(
          Effect.provide(
            SubscriptionProviderRegistry.pipe(
              Layer.provide(GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)))),
            ),
          ),
        );
      }),
    ),
  ));
