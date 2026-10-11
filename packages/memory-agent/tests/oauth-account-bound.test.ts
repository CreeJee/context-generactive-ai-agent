import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";
import { nativeStream } from "../src/runtime/native-stream.ts";
import { Array as EffectArray } from "effect";
import { it as effectTest } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import {
  Cause,
  Deferred,
  Fiber,
  MutableHashMap,
  Option,
  Effect,
  Result,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { describe, expect } from "vite-plus/test";
import { migrations } from "../src/db/migrations.ts";
import { createAccountBoundSubscriptionClients } from "../src/oauth/account-bound.ts";
import {
  listOAuthProfiles,
  removeOAuthProfile,
  selectOAuthProfile,
  type ProfileCredentialStore,
} from "../src/oauth/accounts.ts";
import { acquireOAuthProfileRun } from "../src/oauth/run-leases.ts";
import {
  OAuthHarnessError,
  type CredentialStore,
  type OAuthConnectionStatus,
  type StoredCredential,
} from "../src/oauth/validation-harness.ts";
import type { SubscriptionOAuthClient } from "../src/oauth/validation-harness.ts";
import { providerProtocols, type OAuthProvider } from "../src/oauth/protocol.ts";
import { createSubscriptionProvider } from "../src/providers/subscription-provider.ts";
import {
  createSubscriptionRuntime,
  releaseSubscriptionRun,
} from "../src/providers/subscription-runtime.ts";

const sdkCall = Effect.fn("oauthBound.sdkCall")(function* <A>(operation: () => A | PromiseLike<A>) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const rejects = Effect.fn("oauthBound.rejects")(function* <A>(
  operation: () => PromiseLike<A>,
  message: string,
) {
  const result = yield* Effect.result(sdkCall(operation));
  Result.match(result, {
    onSuccess: () => {
      throw new Error("Expected SDK failure");
    },
    onFailure: (error) =>
      expect(() => {
        throw error.cause;
      }).toThrow(message),
  });
});
// The SDK requires a Promise. Its waiting Fiber is still owned by the caller fixture Scope.
function sdkCompletion<A, E>(program: Effect.Effect<A, E>, scope: Scope.Scope): Promise<A> {
  return Effect.runPromise(program.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)));
}
const sqliteFixture = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (db) =>
    Effect.sync(() => {
      if (db.isOpen) db.close();
    }),
);

const oauthSchema = migrations
  .filter(
    (sql) =>
      sql.includes("CREATE TABLE oauth_profiles (") ||
      sql.includes("CREATE TABLE oauth_legacy_removed ("),
  )
  .join("\n");
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;
const dbFixture = Effect.fn("oauthBound.dbFixture")(function* (provider: OAuthProvider = "openai") {
  const db = yield* sqliteFixture;
  db.exec(oauthSchema);
  for (const [index, id] of ids.entries())
    db.prepare(
      "INSERT INTO oauth_profiles(id, provider, label, selected, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, provider, `account ${index}`, index === 0 ? 1 : 0, index);
  return db;
});
const select = (db: DatabaseSync, id: string, provider: OAuthProvider = "openai") => {
  db.prepare("UPDATE oauth_profiles SET selected = 0 WHERE provider = ?").run(provider);
  db.prepare("UPDATE oauth_profiles SET selected = 1 WHERE id = ? AND provider = ?").run(
    id,
    provider,
  );
};

describe("account-bound subscription provider", () => {
  effectTest.live.each(["openai", "anthropic"] as const)(
    "%s can log in again after removing the last legacy account",
    (provider) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const db = new DatabaseSync(":memory:");
        db.exec(oauthSchema);
        const legacyId = `legacy-${provider}`;
        db.prepare(
          "INSERT INTO oauth_profiles(id, provider, label, selected, created_at) VALUES (?, ?, ?, 1, 0)",
        ).run(legacyId, provider, "old account");
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
        try {
          const bound = createAccountBoundSubscriptionClients({
            sqlite: db,
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
            expect((yield* configured.auth.disconnect).status).toBe("signed-out");
            expect(listOAuthProfiles({ sqlite: db, provider: provider })).toEqual([]);
            expect(() => bound.forRun()).toThrow("not_connected");
            expect((yield* configured.auth.connect).status).toBe("pending");
            expect(listOAuthProfiles({ sqlite: db, provider: provider })).toEqual([]);
            finish();
            expect(
              (yield* configured.auth.status.pipe(
                Effect.repeat({
                  while: (status) => status.status !== "signed-in",
                  schedule: Schedule.spaced("20 millis"),
                }),
                Effect.timeout("1000 millis"),
              )).status,
            ).toBe("signed-in");
            expect(listOAuthProfiles({ sqlite: db, provider: provider })).toMatchObject([
              { id: created[round], provider, selected: true },
            ]);
            bound.forRun().releaseRun();
          }
          expect(legacyRemoved).toBe(true);
          expect(EffectArray.dedupe(created).length).toBe(2);
          expect(db.prepare("SELECT provider FROM oauth_legacy_removed").get()).toEqual({
            provider,
          });
        } finally {
          db.close();
        }
      }),
  );

  effectTest.live.each(["cancel", "reject"] as const)(
    "%s leaves no newly connected account",
    (intent) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const db = new DatabaseSync(":memory:");
        db.exec(oauthSchema);
        db.prepare(
          "INSERT INTO oauth_legacy_removed(provider, removed_at) VALUES ('openai', 0)",
        ).run();
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
        try {
          const bound = createAccountBoundSubscriptionClients({
            sqlite: db,
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
                          ? Effect.fail(new OAuthHarnessError("provider_rejected"))
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
            () => attempt.completed,
            intent === "cancel" ? "cancelled" : "provider_rejected",
          );
          expect(removed).toHaveLength(1);
          expect(listOAuthProfiles({ sqlite: db, provider: "openai" })).toEqual([]);
          expect((yield* sdkCall(() => bound.client.status())).connected).toBe(false);
          expect(() => bound.forRun()).toThrow("not_connected");
        } finally {
          db.close();
        }
      }),
  );

  effectTest.live.each(["openai", "anthropic"] as const)(
    "%s keeps A's stream/refresh bound after switching to B",
    (provider) =>
      Effect.gen(function* () {
        const db = yield* dbFixture(provider);
        const calls: string[] = [];
        try {
          const bound = createAccountBoundSubscriptionClients({
            sqlite: db,
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
          select(db, ids[1], provider);
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
        } finally {
          db.close();
        }
      }),
  );

  effectTest.live(
    "catalog/status and a pinned run keep their original account on A/B switches",
    () =>
      Effect.gen(function* () {
        const db = yield* dbFixture();
        const calls: string[] = [];
        const created: string[] = [];
        try {
          const bound = createAccountBoundSubscriptionClients({
            sqlite: db,
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
          const firstAdapter = runtime.adapter(selection);
          const aRun = bound.forRun();
          expect(bound.catalogKey()).toBe(ids[0]);
          select(db, ids[1]);
          const secondAdapter = runtime.adapter(selection);
          expect(firstAdapter).not.toBe(secondAdapter);
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
          releaseSubscriptionRun(firstAdapter);
          releaseSubscriptionRun(secondAdapter);
          aRun.releaseRun();
          bRun.releaseRun();
        } finally {
          db.close();
        }
      }),
  );

  effectTest.effect(
    "OpenAI model cache and context window cannot leak across selected profiles",
    () =>
      Effect.gen(function* () {
        const db = yield* dbFixture();
        const requests: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (db.isOpen) db.close();
          }),
        );

        const bound = createAccountBoundSubscriptionClients({
          sqlite: db,
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
        select(db, ids[1]);
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
        const db = yield* dbFixture();
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
        try {
          const bound = createAccountBoundSubscriptionClients({
            sqlite: db,
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
          select(db, ids[1]);
          const pinnedB = bound.forRun();
          yield* rejects(
            () =>
              removeOAuthProfile({
                sqlite: db,
                provider: "openai",
                id: ids[0],
                accounts: accounts,
                legacy: legacy,
              }),
            "oauth_profile_in_use",
          );
          expect(MutableHashMap.has(vault, ids[0])).toBe(true);
          pinnedA.releaseRun();
          pinnedA.releaseRun(); // release is idempotent
          yield* sdkCall(() =>
            removeOAuthProfile({
              sqlite: db,
              provider: "openai",
              id: ids[0],
              accounts: accounts,
              legacy: legacy,
            }),
          );
          expect(MutableHashMap.has(vault, ids[0])).toBe(false);
          expect(MutableHashMap.has(vault, ids[1])).toBe(true);
          expect(db.prepare("SELECT id FROM oauth_profiles WHERE selected = 1").get()).toEqual({
            id: ids[1],
          });
          yield* rejects(
            () =>
              removeOAuthProfile({
                sqlite: db,
                provider: "openai",
                id: ids[1],
                accounts: accounts,
                legacy: legacy,
              }),
            "oauth_profile_in_use",
          );
          pinnedB.releaseRun();
        } finally {
          db.close();
        }
      }),
  );

  effectTest.live(
    "a pending vault deletion rejects a newly started run before any credential is removed",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const db = yield* dbFixture();
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
            sqlite: db,
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
            sdkCall(() =>
              removeOAuthProfile({
                sqlite: db,
                provider: "openai",
                id: ids[0],
                accounts: accounts,
                legacy: legacy,
              }),
            ).pipe(Effect.uninterruptible),
          );
          yield* Deferred.await(reading);
          expect(() => bound.forRun()).toThrow("oauth_profile_removing");
          yield* rejects(
            () =>
              selectOAuthProfile({
                sqlite: db,
                provider: "openai",
                id: ids[0],
                accounts: accounts,
              }),
            "oauth_profile_removing",
          );
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
      const db = yield* dbFixture();
      try {
        const release = acquireOAuthProfileRun(db, "openai", ids[0]);
        const releaseOther = acquireOAuthProfileRun(db, "anthropic", ids[0]);
        releaseOther();
        release();
      } finally {
        db.close();
      }
    }),
  );
});
