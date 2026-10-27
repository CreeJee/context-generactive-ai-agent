import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";
import { AuthConnectionState } from "../src/providers/contracts.ts";
import { nativeStream } from "../src/runtime/native-stream.ts";
import { Array as EffectArray } from "effect";
import { it as effectTest } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Layer,
  Fiber,
  MutableHashMap,
  Option,
  Effect,
  Exit,
  Result,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { describe, expect } from "vite-plus/test";
import { SqlClient } from "effect/sql";
import { Database } from "../src/db/database.ts";
import { createAccountBoundSubscriptionClients } from "../src/oauth/account-bound.ts";
import { OAuthProfiles, type ProfileCredentialStore } from "../src/oauth/accounts.ts";
import {
  OAuthHarnessError,
  type CredentialStore,
  type OAuthConnectionStatus,
  type StoredCredential,
} from "../src/oauth/validation-harness.ts";
import type { SubscriptionOAuthClient } from "../src/oauth/validation-harness.ts";
import { providerProtocols, type OAuthProvider } from "../src/oauth/protocol.ts";
import { createSubscriptionProvider } from "../src/providers/subscription-provider.ts";
import { createSubscriptionRuntime } from "../src/providers/subscription-runtime.ts";

const sdkCall = Effect.fn("oauthBound.sdkCall")(function* <A>(operation: () => A | PromiseLike<A>) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const rejects = Effect.fn("oauthBound.rejects")(function* <A, E>(
  operation: Effect.Effect<A, E>,
  message: string,
) {
  const result = yield* Effect.result(operation);
  Result.match(result, {
    onSuccess: () => {
      throw new Error("Expected SDK failure");
    },
    onFailure: (error) =>
      expect(() => {
        throw error instanceof Cause.UnknownError ? error.cause : error;
      }).toThrow(message),
  });
});
// The SDK requires a Promise. Its waiting Fiber is still owned by the caller fixture Scope.
function sdkCompletion<A, E>(program: Effect.Effect<A, E>, scope: Scope.Scope): Promise<A> {
  return Effect.runPromise(program.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)));
}
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;
const storedCredential: StoredCredential = {
  accessToken: "fake",
  refreshToken: "fake",
  expiresAt: 123,
};
/** A profile store over a fresh database that `seed` filled before the store first read it. */
const seededProfiles = Effect.fn("oauthBound.seededProfiles")(function* <E>(
  seed: Effect.Effect<unknown, E, SqlClient.SqlClient>,
) {
  const database = yield* Layer.build(Database.layer(":memory:"));
  yield* Effect.provideContext(seed, database);
  const services = yield* Layer.build(
    OAuthProfiles.layer.pipe(Layer.provide(Layer.succeedContext(database))),
  );
  return Context.get(services, OAuthProfiles);
});
/** Two profiles with intact vault slots; the first is selected. */
const dbFixture = Effect.fn("oauthBound.dbFixture")(function* (provider: OAuthProvider = "openai") {
  const profiles = yield* seededProfiles(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [index, id] of ids.entries())
        yield* sql`INSERT INTO oauth_profiles(id, provider, label, selected, created_at)
          VALUES (${id}, ${provider}, ${`account ${index}`}, ${index === 0 ? 1 : 0}, ${index})`;
    }),
  );
  const vault: ProfileCredentialStore = {
    read: () => Promise.resolve().then(() => storedCredential),
    write: () => Promise.resolve().then(() => {}),
    remove: () => Promise.resolve().then(() => {}),
  };
  const select = (id: string) => profiles.select(provider, id, vault);
  return { profiles, select };
});

describe("account-bound subscription provider", () => {
  effectTest.live.each(["openai", "anthropic"] as const)(
    "%s can log in again after removing the last legacy account",
    (provider) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const legacyId = `legacy-${provider}`;
        const profiles = yield* seededProfiles(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO oauth_profiles(id, provider, label, selected, created_at)
              VALUES (${legacyId}, ${provider}, 'old account', 1, 0)`;
          }),
        );
        const credential: StoredCredential = {
          accessToken: "fake",
          refreshToken: "fake",
          expiresAt: 123,
        };
        const vault = MutableHashMap.fromIterable<string, StoredCredential>([
          [legacyId, credential],
        ]);
        const accounts: ProfileCredentialStore = {
          read: (_provider, id) =>
            Promise.resolve().then(
              () => Option.getOrUndefined(MutableHashMap.get(vault, id)) ?? null,
            ),
          write: (_provider, id, value) =>
            Promise.resolve().then(() => {
              MutableHashMap.set(vault, id, value);
            }),
          remove: (_provider, id) =>
            Promise.resolve().then(() => {
              MutableHashMap.remove(vault, id);
            }),
        };
        let legacyRemoved = false;
        const legacy: CredentialStore = {
          read: () => Promise.resolve().then(() => (legacyRemoved ? null : credential)),
          write: () => Promise.resolve().then(() => {}),
          remove: () =>
            Promise.resolve().then(() => {
              legacyRemoved = true;
            }),
        };
        const created: string[] = [];
        let finish!: () => void;
        const bound = createAccountBoundSubscriptionClients({
          profiles,
          provider: provider,
          createClient: (id) => ({
            status: () =>
              Promise.resolve().then(() => ({
                provider,
                connected: MutableHashMap.has(vault, id!),
                expiresAt: null,
              })),
            modelCatalog: () => Promise.resolve().then(() => []),
            stream: () => nativeStream(Stream.empty),
            refreshForValidation: () =>
              Promise.resolve().then(() => ({ provider, connected: true, expiresAt: null })),
            disconnect: () =>
              Promise.resolve().then(() => ({ provider, connected: false, expiresAt: null })),
            startLogin: () =>
              Promise.resolve().then(() => {
                expect(id).not.toBeNull();
                created.push(id!);
                const completion = Deferred.makeUnsafe<OAuthConnectionStatus>();
                finish = () => {
                  MutableHashMap.set(vault, id!, credential);
                  Deferred.doneUnsafe(
                    completion,
                    Effect.succeed({ provider, connected: true, expiresAt: null }),
                  );
                };
                const completed = sdkCompletion(Deferred.await(completion), scope);
                return {
                  provider,
                  authorizationUrl: "https://example.com/login",
                  completed,
                  cancel: () => {},
                };
              }),
          }),
          accounts: accounts,
          legacy: legacy,
        });
        const configured = createSubscriptionProvider({
          protocol: providerProtocols[provider],
          config: { read: Effect.succeed({}), update: (patch) => Effect.succeed(patch) },
          client: bound.client,
          catalogKey: bound.catalogKey,
        });
        for (let round = 0; round < 2; round++) {
          expect(AuthConnectionState.$is("signed-out")(yield* configured.auth.disconnect)).toBe(
            true,
          );
          expect(yield* profiles.list(provider)).toEqual([]);
          expect(() => bound.forRun()).toThrow("not_connected");
          expect(AuthConnectionState.$is("pending")(yield* configured.auth.connect)).toBe(true);
          expect(yield* profiles.list(provider)).toEqual([]);
          finish();
          expect(
            AuthConnectionState.$is("signed-in")(
              yield* configured.auth.status.pipe(
                Effect.repeat({
                  until: AuthConnectionState.$is("signed-in"),
                  schedule: Schedule.spaced("20 millis"),
                }),
                Effect.timeout("1000 millis"),
              ),
            ),
          ).toBe(true);
          expect(yield* profiles.list(provider)).toMatchObject([
            { id: created[round], provider, selected: true },
          ]);
          bound.forRun().releaseRun();
        }
        expect(legacyRemoved).toBe(true);
        expect(EffectArray.dedupe(created).length).toBe(2);
        expect(profiles.committed(provider).legacyRemoved).toBe(true);
      }),
  );

  effectTest.live.each(["cancel", "reject"] as const)(
    "%s leaves no newly connected account",
    (intent) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const profiles = yield* seededProfiles(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO oauth_legacy_removed(provider, removed_at) VALUES ('openai', 0)`;
          }),
        );
        const removed: string[] = [];
        const accounts: ProfileCredentialStore = {
          read: () => Promise.resolve().then(() => null),
          write: () => Promise.resolve().then(() => {}),
          remove: (_provider, id) =>
            Promise.resolve().then(() => {
              removed.push(id);
            }),
        };
        let finish!: () => void;
        const bound = createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: () => ({
            status: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                connected: false,
                expiresAt: null,
              })),
            modelCatalog: () => Promise.resolve().then(() => []),
            stream: () => nativeStream(Stream.empty),
            refreshForValidation: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                connected: false,
                expiresAt: null,
              })),
            disconnect: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                connected: false,
                expiresAt: null,
              })),
            startLogin: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                authorizationUrl: "https://example.com/login",
                completed: (() => {
                  const completion = Deferred.makeUnsafe<
                    OAuthConnectionStatus,
                    OAuthHarnessError
                  >();
                  finish = () =>
                    Deferred.doneUnsafe(
                      completion,
                      intent === "reject"
                        ? Effect.fail(OAuthHarnessError.fromCode("provider_rejected"))
                        : Effect.succeed({
                            provider: "openai",
                            connected: true,
                            expiresAt: null,
                          }),
                    );
                  return sdkCompletion(Deferred.await(completion), scope);
                })(),
                cancel: () => {},
              })),
          }),
          accounts: accounts,
        });
        const attempt = yield* sdkCall(() => bound.client.startLogin());
        if (intent === "cancel") attempt.cancel();
        finish();
        yield* rejects(
          sdkCall(() => attempt.completed),
          intent === "cancel" ? "cancelled" : "provider_rejected",
        );
        expect(removed).toHaveLength(1);
        expect(yield* profiles.list("openai")).toEqual([]);
        expect((yield* sdkCall(() => bound.client.status())).connected).toBe(false);
        expect(() => bound.forRun()).toThrow("not_connected");
      }),
  );

  effectTest.live("a failed slot cleanup keeps the login's own failure", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const profiles = yield* seededProfiles(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO oauth_legacy_removed(provider, removed_at) VALUES ('openai', 0)`;
        }),
      );
      const disconnected = () =>
        Promise.resolve().then(() => ({
          provider: "openai" as const,
          connected: false,
          expiresAt: null,
        }));
      const bound = createAccountBoundSubscriptionClients({
        profiles,
        provider: "openai",
        createClient: () => ({
          status: disconnected,
          modelCatalog: () => Promise.resolve().then(() => []),
          stream: () => nativeStream(Stream.empty),
          refreshForValidation: disconnected,
          disconnect: disconnected,
          startLogin: () =>
            Promise.resolve().then(() => ({
              provider: "openai" as const,
              authorizationUrl: "https://example.com/login",
              completed: sdkCompletion(
                Effect.fail(OAuthHarnessError.fromCode("provider_rejected")),
                scope,
              ),
              cancel: () => {},
            })),
        }),
        accounts: {
          read: () => Promise.resolve().then(() => null),
          write: () => Promise.resolve().then(() => {}),
          remove: () => Promise.reject(new Error("keychain_locked")),
        },
      });
      const attempt = yield* sdkCall(() => bound.client.startLogin());
      yield* rejects(
        sdkCall(() => attempt.completed),
        "provider_rejected",
      );
    }),
  );

  effectTest.live.each(["openai", "anthropic"] as const)(
    "%s keeps A's stream/refresh bound after switching to B",
    (provider) =>
      Effect.gen(function* () {
        const { profiles, select } = yield* dbFixture(provider);
        const calls: string[] = [];
        const bound = createAccountBoundSubscriptionClients({
          profiles,
          provider: provider,
          createClient: (id) => ({
            status: () =>
              Promise.resolve().then(() => ({ provider, connected: true, expiresAt: null })),
            modelCatalog: () =>
              Promise.resolve().then(() => {
                calls.push(`catalog:${id}`);
                return [];
              }),
            stream: () =>
              nativeStream(
                Stream.suspend(() =>
                  Stream.fromIterable(
                    (function* (): Generator<NormalizedStreamEvent> {
                      calls.push(`stream:${id}`);
                      yield* [];
                    })(),
                  ),
                ),
              ),
            refreshForValidation: () =>
              Promise.resolve().then(() => {
                calls.push(`refresh:${id}`);
                return { provider, connected: true, expiresAt: null };
              }),
            disconnect: () =>
              Promise.resolve().then(() => ({ provider, connected: false, expiresAt: null })),
            startLogin: () =>
              Promise.resolve().then(() => {
                throw new Error("unexpected login");
              }),
          }),
        });
        const a = bound.forRun();
        yield* select(ids[1]);
        const b = bound.forRun();
        yield* sdkCall(() => bound.client.modelCatalog());
        yield* Stream.runDrain(
          Stream.fromAsyncIterable(a.stream("{}"), (cause) => new Cause.UnknownError(cause)),
        );
        yield* Stream.runDrain(
          Stream.fromAsyncIterable(b.stream("{}"), (cause) => new Cause.UnknownError(cause)),
        );
        yield* sdkCall(() => a.refreshForValidation());
        yield* sdkCall(() => b.refreshForValidation());
        expect(calls).toEqual([
          `catalog:${ids[1]}`,
          `stream:${ids[0]}`,
          `stream:${ids[1]}`,
          `refresh:${ids[0]}`,
          `refresh:${ids[1]}`,
        ]);
        a.releaseRun();
        b.releaseRun();
      }),
  );

  effectTest.live(
    "catalog/status and a pinned run keep their original account on A/B switches",
    () =>
      Effect.gen(function* () {
        const { profiles, select } = yield* dbFixture();
        const calls: string[] = [];
        const created: string[] = [];
        const bound = createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: (id) => {
            created.push(id ?? "legacy");
            return {
              status: () =>
                Promise.resolve().then(() => {
                  calls.push(`status:${id}`);
                  return { provider: "openai", connected: true, expiresAt: null };
                }),
              modelCatalog: () =>
                Promise.resolve().then(() => {
                  calls.push(`catalog:${id}`);
                  return [{ models: [{ slug: `model-${id}` }] }];
                }),
              stream: () =>
                nativeStream(
                  Stream.suspend(() =>
                    Stream.fromIterable(
                      (function* (): Generator<NormalizedStreamEvent> {
                        calls.push(`stream:${id}`);
                        yield* [];
                      })(),
                    ),
                  ),
                ),
              refreshForValidation: () =>
                Promise.resolve().then(() => {
                  calls.push(`refresh:${id}`);
                  return { provider: "openai", connected: true, expiresAt: null };
                }),
              disconnect: () =>
                Promise.resolve().then(() => ({
                  provider: "openai",
                  connected: false,
                  expiresAt: null,
                })),
              startLogin: () =>
                Promise.resolve().then(() => {
                  throw new Error("unexpected login");
                }),
            } satisfies SubscriptionOAuthClient;
          },
        });
        const runtime = createSubscriptionRuntime("openai", bound.forRun);
        const selection = {
          provider: "openai",
          model: "gpt-test",
          reasoningEffort: "low",
        } as const;
        const run = { threadId: "thread", runId: "run", cacheRetention: "none" } as const;
        const firstModel = yield* Scope.make();
        yield* Scope.provide(runtime.model(selection, run), firstModel);
        const aRun = bound.forRun();
        expect(bound.catalogKey()).toBe(ids[0]);
        yield* select(ids[1]);
        const secondModel = yield* Scope.make();
        yield* Scope.provide(runtime.model(selection, run), secondModel);
        const bRun = bound.forRun();
        yield* sdkCall(() => bound.client.status());
        yield* sdkCall(() => bound.client.modelCatalog());
        yield* Stream.runDrain(
          Stream.fromAsyncIterable(aRun.stream("{}"), (cause) => new Cause.UnknownError(cause)),
        );
        yield* Stream.runDrain(
          Stream.fromAsyncIterable(bRun.stream("{}"), (cause) => new Cause.UnknownError(cause)),
        );
        yield* sdkCall(() => aRun.refreshForValidation());
        yield* sdkCall(() => bRun.refreshForValidation());
        expect(created).toEqual([ids[0], ids[1]]);
        expect(calls).toEqual([
          `status:${ids[1]}`,
          `catalog:${ids[1]}`,
          `stream:${ids[0]}`,
          `stream:${ids[1]}`,
          `refresh:${ids[0]}`,
          `refresh:${ids[1]}`,
        ]);
        yield* Scope.close(firstModel, Exit.void);
        yield* Scope.close(secondModel, Exit.void);
        aRun.releaseRun();
        bRun.releaseRun();
      }),
  );

  effectTest.effect(
    "OpenAI model cache and context window cannot leak across selected profiles",
    () =>
      Effect.gen(function* () {
        const { profiles, select } = yield* dbFixture();
        const requests: string[] = [];

        const bound = createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: (id) => ({
            status: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                connected: true,
                expiresAt: null,
              })),
            modelCatalog: () =>
              Promise.resolve().then(() => {
                requests.push(id!);
                return [
                  {
                    models: [
                      {
                        slug: id === ids[0] ? "model-a" : "model-b",
                        context_window: id === ids[0] ? 100_000 : 200_000,
                      },
                    ],
                  },
                ];
              }),
            stream: () => nativeStream(Stream.empty),
            refreshForValidation: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                connected: true,
                expiresAt: null,
              })),
            disconnect: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                connected: false,
                expiresAt: null,
              })),
            startLogin: () =>
              Promise.resolve().then(() => {
                throw new Error("unexpected login");
              }),
          }),
        });
        const provider = createSubscriptionProvider({
          protocol: providerProtocols.openai,
          config: { read: Effect.succeed({}), update: (patch) => Effect.succeed(patch) },
          client: bound.client,
          catalogKey: bound.catalogKey,
        });
        expect((yield* provider.models.list).map((m) => m.id)).toEqual(["model-a"]);
        expect(provider.contextWindow("model-a")).toBe(100_000);
        yield* select(ids[1]);
        expect(provider.contextWindow("model-a")).toBeNull();
        expect((yield* provider.models.list).map((m) => m.id)).toEqual(["model-b"]);
        expect(provider.contextWindow("model-b")).toBe(200_000);
        expect(requests).toEqual([ids[0], ids[1]]);
      }),
  );

  effectTest.live(
    "an active run blocks only its own profile deletion until released, even after A/B switch",
    () =>
      Effect.gen(function* () {
        const { profiles, select } = yield* dbFixture();
        const credential: StoredCredential = {
          accessToken: "fake",
          refreshToken: "fake",
          expiresAt: 123,
        };
        const vault = MutableHashMap.fromIterable<string, StoredCredential>(
          ids.map((id) => [id, credential]),
        );
        const accounts: ProfileCredentialStore = {
          read: (_provider, id) =>
            Promise.resolve().then(
              () => Option.getOrUndefined(MutableHashMap.get(vault, id)) ?? null,
            ),
          write: (_provider, id, value) =>
            Promise.resolve().then(() => {
              MutableHashMap.set(vault, id, value);
            }),
          remove: (_provider, id) =>
            Promise.resolve().then(() => {
              MutableHashMap.remove(vault, id);
            }),
        };
        const legacy: CredentialStore = {
          read: () => Promise.resolve().then(() => null),
          write: () => Promise.resolve().then(() => {}),
          remove: () => Promise.resolve().then(() => {}),
        };
        const bound = createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: () => ({
            status: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                connected: true,
                expiresAt: null,
              })),
            modelCatalog: () => Promise.resolve().then(() => []),
            stream: () => nativeStream(Stream.empty),
            refreshForValidation: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                connected: true,
                expiresAt: null,
              })),
            disconnect: () =>
              Promise.resolve().then(() => ({
                provider: "openai",
                connected: false,
                expiresAt: null,
              })),
            startLogin: () =>
              Promise.resolve().then(() => {
                throw new Error("unexpected login");
              }),
          }),
        });
        const pinnedA = bound.forRun();
        yield* select(ids[1]);
        const pinnedB = bound.forRun();
        yield* rejects(profiles.remove("openai", ids[0], accounts, legacy), "oauth_profile_in_use");
        expect(MutableHashMap.has(vault, ids[0])).toBe(true);
        pinnedA.releaseRun();
        pinnedA.releaseRun(); // release is idempotent
        yield* profiles.remove("openai", ids[0], accounts, legacy);
        expect(MutableHashMap.has(vault, ids[0])).toBe(false);
        expect(MutableHashMap.has(vault, ids[1])).toBe(true);
        expect((yield* profiles.list("openai")).filter((p) => p.selected).map((p) => p.id)).toEqual(
          [ids[1]],
        );
        yield* rejects(profiles.remove("openai", ids[1], accounts, legacy), "oauth_profile_in_use");
        pinnedB.releaseRun();
      }),
  );

  effectTest.live(
    "a pending vault deletion rejects a newly started run before any credential is removed",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const { profiles } = yield* dbFixture();
        const reading = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        const credential: StoredCredential = {
          accessToken: "fake",
          refreshToken: "fake",
          expiresAt: 123,
        };
        const accounts: ProfileCredentialStore = {
          read: () =>
            sdkCompletion(
              Effect.gen(function* () {
                yield* Deferred.succeed(reading, undefined);
                yield* Deferred.await(held);
                return credential;
              }),
              scope,
            ),
          write: () => Promise.resolve().then(() => {}),
          remove: () => Promise.resolve().then(() => {}),
        };
        const legacy: CredentialStore = {
          read: () => Promise.resolve().then(() => null),
          write: () => Promise.resolve().then(() => {}),
          remove: () => Promise.resolve().then(() => {}),
        };
        try {
          const bound = createAccountBoundSubscriptionClients({
            profiles,
            provider: "openai",
            createClient: () => ({
              status: () =>
                Promise.resolve().then(() => ({
                  provider: "openai",
                  connected: true,
                  expiresAt: null,
                })),
              modelCatalog: () => Promise.resolve().then(() => []),
              stream: () => nativeStream(Stream.empty),
              refreshForValidation: () =>
                Promise.resolve().then(() => ({
                  provider: "openai",
                  connected: true,
                  expiresAt: null,
                })),
              disconnect: () =>
                Promise.resolve().then(() => ({
                  provider: "openai",
                  connected: false,
                  expiresAt: null,
                })),
              startLogin: () =>
                Promise.resolve().then(() => {
                  throw new Error("unexpected login");
                }),
            }),
          });
          const removal = yield* Effect.forkChild(
            profiles.remove("openai", ids[0], accounts, legacy).pipe(Effect.uninterruptible),
          );
          yield* Deferred.await(reading);
          expect(() => bound.forRun()).toThrow("oauth_profile_removing");
          yield* rejects(profiles.select("openai", ids[0], accounts), "oauth_profile_removing");
          yield* Deferred.succeed(held, undefined);
          yield* Fiber.join(removal);
          const next = bound.forRun(); // fallback selected B can run
          next.releaseRun();
        } finally {
          yield* Deferred.succeed(held, undefined);
        }
      }),
  );

  effectTest.live("leases are provider-scoped on the same database", () =>
    Effect.gen(function* () {
      const { profiles } = yield* dbFixture();
      const release = profiles.acquireRun("openai", ids[0]);
      const releaseOther = profiles.acquireRun("anthropic", ids[0]);
      releaseOther();
      release();
    }),
  );
});
