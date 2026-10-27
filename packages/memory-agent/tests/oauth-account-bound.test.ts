import { AuthConnectionState } from "../src/providers/contracts.ts";
import { Array as EffectArray } from "effect";
import { it as effectTest } from "@effect/vitest";
import {
  Context,
  Deferred,
  Layer,
  Fiber,
  MutableHashMap,
  Option,
  Effect,
  Exit,
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
import { withOAuthTestPlatform } from "./support/platform.ts";

const rejects = Effect.fn("oauthBound.rejects")(function* <
  A,
  E extends { readonly message: string },
  R,
>(operation: Effect.Effect<A, E, R>, message: string) {
  expect((yield* Effect.flip(operation)).message).toContain(message);
});
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;
const storedCredential: StoredCredential = {
  accessToken: "fake",
  refreshToken: "fake",
  expiresAt: 123,
};
const connection = (provider: OAuthProvider, connected: boolean): OAuthConnectionStatus => ({
  provider,
  connected,
  expiresAt: null,
});
/** A connected client with no models or events; each test replaces the operations it observes. */
const fakeClient = (
  provider: OAuthProvider,
  operations: Partial<SubscriptionOAuthClient> = {},
): SubscriptionOAuthClient => ({
  status: Effect.succeed(connection(provider, true)),
  modelCatalog: Effect.succeed([]),
  stream: () => Stream.empty,
  refreshForValidation: Effect.succeed(connection(provider, true)),
  disconnect: Effect.succeed(connection(provider, false)),
  startLogin: () => Effect.die("unexpected login"),
  ...operations,
});
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
    read: () => Effect.succeed(storedCredential),
    write: () => Effect.void,
    remove: () => Effect.void,
  };
  const select = (id: string) => profiles.select(provider, id, vault);
  return { profiles, select };
});

describe("account-bound subscription provider", () => {
  effectTest.live.each(["openai", "anthropic"] as const)(
    "%s can log in again after removing the last legacy account",
    (provider) =>
      Effect.gen(function* () {
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
            Effect.sync(() => Option.getOrNull(MutableHashMap.get(vault, id))),
          write: (_provider, id, value) =>
            Effect.sync(() => {
              MutableHashMap.set(vault, id, value);
            }),
          remove: (_provider, id) =>
            Effect.sync(() => {
              MutableHashMap.remove(vault, id);
            }),
        };
        let legacyRemoved = false;
        const legacy: CredentialStore = {
          read: () => Effect.sync(() => (legacyRemoved ? null : credential)),
          write: () => Effect.void,
          remove: () =>
            Effect.sync(() => {
              legacyRemoved = true;
            }),
        };
        const created: string[] = [];
        let finish!: Effect.Effect<boolean>;
        const bound = yield* createAccountBoundSubscriptionClients({
          profiles,
          provider: provider,
          createClient: (id) =>
            Effect.succeed(
              fakeClient(provider, {
                status: Effect.sync(() => connection(provider, MutableHashMap.has(vault, id!))),
                startLogin: () =>
                  Effect.gen(function* () {
                    expect(id).not.toBeNull();
                    created.push(id!);
                    const completion = yield* Deferred.make<OAuthConnectionStatus>();
                    finish = Effect.sync(() => {
                      MutableHashMap.set(vault, id!, credential);
                    }).pipe(
                      Effect.andThen(Deferred.succeed(completion, connection(provider, true))),
                    );
                    return {
                      provider,
                      authorizationUrl: "https://example.com/login",
                      completed: Deferred.await(completion),
                      cancel: Effect.void,
                    };
                  }),
              }),
            ),
          accounts: accounts,
          legacy: legacy,
        });
        const configured = yield* createSubscriptionProvider({
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
          yield* rejects(Effect.scoped(bound.forRun), "not_connected");
          expect(AuthConnectionState.$is("pending")(yield* configured.auth.connect)).toBe(true);
          expect(yield* profiles.list(provider)).toEqual([]);
          yield* finish;
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
          yield* Effect.scoped(bound.forRun);
        }
        expect(legacyRemoved).toBe(true);
        expect(EffectArray.dedupe(created).length).toBe(2);
        expect(profiles.committed(provider).legacyRemoved).toBe(true);
      }).pipe(withOAuthTestPlatform),
  );

  effectTest.live.each(["cancel", "reject"] as const)(
    "%s leaves no newly connected account",
    (intent) =>
      Effect.gen(function* () {
        const profiles = yield* seededProfiles(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO oauth_legacy_removed(provider, removed_at) VALUES ('openai', 0)`;
          }),
        );
        const removed: string[] = [];
        const accounts: ProfileCredentialStore = {
          read: () => Effect.succeed(null),
          write: () => Effect.void,
          remove: (_provider, id) =>
            Effect.sync(() => {
              removed.push(id);
            }),
        };
        const disconnected = Effect.succeed(connection("openai", false));
        let finish!: Effect.Effect<boolean>;
        const bound = yield* createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: () =>
            Effect.succeed(
              fakeClient("openai", {
                status: disconnected,
                refreshForValidation: disconnected,
                startLogin: () =>
                  Effect.gen(function* () {
                    const completion = yield* Deferred.make<
                      OAuthConnectionStatus,
                      OAuthHarnessError
                    >();
                    finish =
                      intent === "reject"
                        ? Deferred.fail(completion, OAuthHarnessError.fromCode("provider_rejected"))
                        : Deferred.succeed(completion, connection("openai", true));
                    return {
                      provider: "openai",
                      authorizationUrl: "https://example.com/login",
                      completed: Deferred.await(completion),
                      cancel: Effect.void,
                    };
                  }),
              }),
            ),
          accounts: accounts,
        });
        const attempt = yield* bound.client.startLogin;
        yield* Effect.when(attempt.cancel, Effect.succeed(intent === "cancel"));
        yield* finish;
        yield* rejects(attempt.completed, intent === "cancel" ? "cancelled" : "provider_rejected");
        expect(removed).toHaveLength(1);
        expect(yield* profiles.list("openai")).toEqual([]);
        expect((yield* bound.client.status).connected).toBe(false);
        yield* rejects(Effect.scoped(bound.forRun), "not_connected");
      }).pipe(withOAuthTestPlatform),
  );

  effectTest.live("a failed slot cleanup keeps the login's own failure", () =>
    Effect.gen(function* () {
      const profiles = yield* seededProfiles(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO oauth_legacy_removed(provider, removed_at) VALUES ('openai', 0)`;
        }),
      );
      const disconnected = Effect.succeed(connection("openai", false));
      const bound = yield* createAccountBoundSubscriptionClients({
        profiles,
        provider: "openai",
        createClient: () =>
          Effect.succeed(
            fakeClient("openai", {
              status: disconnected,
              refreshForValidation: disconnected,
              startLogin: () =>
                Effect.succeed({
                  provider: "openai" as const,
                  authorizationUrl: "https://example.com/login",
                  completed: Effect.fail(OAuthHarnessError.fromCode("provider_rejected")),
                  cancel: Effect.void,
                }),
            }),
          ),
        accounts: {
          read: () => Effect.succeed(null),
          write: () => Effect.void,
          remove: () => Effect.fail(OAuthHarnessError.fromCode("credential_store_unavailable")),
        },
      });
      const attempt = yield* bound.client.startLogin;
      yield* rejects(attempt.completed, "provider_rejected");
    }).pipe(withOAuthTestPlatform),
  );

  effectTest.live.each(["openai", "anthropic"] as const)(
    "%s keeps A's stream/refresh bound after switching to B",
    (provider) =>
      Effect.gen(function* () {
        const { profiles, select } = yield* dbFixture(provider);
        const calls: string[] = [];
        const bound = yield* createAccountBoundSubscriptionClients({
          profiles,
          provider: provider,
          createClient: (id) =>
            Effect.succeed(
              fakeClient(provider, {
                modelCatalog: Effect.sync(() => {
                  calls.push(`catalog:${id}`);
                  return [];
                }),
                stream: () =>
                  Stream.suspend(() => {
                    calls.push(`stream:${id}`);
                    return Stream.empty;
                  }),
                refreshForValidation: Effect.sync(() => {
                  calls.push(`refresh:${id}`);
                  return connection(provider, true);
                }),
              }),
            ),
        });
        const a = yield* bound.forRun;
        yield* select(ids[1]);
        const b = yield* bound.forRun;
        yield* bound.client.modelCatalog;
        yield* Stream.runDrain(a.stream("{}"));
        yield* Stream.runDrain(b.stream("{}"));
        yield* a.refreshForValidation;
        yield* b.refreshForValidation;
        expect(calls).toEqual([
          `catalog:${ids[1]}`,
          `stream:${ids[0]}`,
          `stream:${ids[1]}`,
          `refresh:${ids[0]}`,
          `refresh:${ids[1]}`,
        ]);
      }).pipe(withOAuthTestPlatform),
  );

  effectTest.live(
    "catalog/status and a pinned run keep their original account on A/B switches",
    () =>
      Effect.gen(function* () {
        const { profiles, select } = yield* dbFixture();
        const calls: string[] = [];
        const created: string[] = [];
        const bound = yield* createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: (id) =>
            Effect.sync(() => {
              created.push(id ?? "legacy");
              return fakeClient("openai", {
                status: Effect.sync(() => {
                  calls.push(`status:${id}`);
                  return connection("openai", true);
                }),
                modelCatalog: Effect.sync(() => {
                  calls.push(`catalog:${id}`);
                  return [{ models: [{ slug: `model-${id}` }] }];
                }),
                stream: () =>
                  Stream.suspend(() => {
                    calls.push(`stream:${id}`);
                    return Stream.empty;
                  }),
                refreshForValidation: Effect.sync(() => {
                  calls.push(`refresh:${id}`);
                  return connection("openai", true);
                }),
              });
            }),
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
        const aRun = yield* bound.forRun;
        expect(bound.catalogKey()).toBe(ids[0]);
        yield* select(ids[1]);
        const secondModel = yield* Scope.make();
        yield* Scope.provide(runtime.model(selection, run), secondModel);
        const bRun = yield* bound.forRun;
        yield* bound.client.status;
        yield* bound.client.modelCatalog;
        yield* Stream.runDrain(aRun.stream("{}"));
        yield* Stream.runDrain(bRun.stream("{}"));
        yield* aRun.refreshForValidation;
        yield* bRun.refreshForValidation;
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
      }).pipe(withOAuthTestPlatform),
  );

  effectTest.effect(
    "OpenAI model cache and context window cannot leak across selected profiles",
    () =>
      Effect.gen(function* () {
        const { profiles, select } = yield* dbFixture();
        const requests: string[] = [];

        const bound = yield* createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: (id) =>
            Effect.succeed(
              fakeClient("openai", {
                modelCatalog: Effect.sync(() => {
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
              }),
            ),
        });
        const provider = yield* createSubscriptionProvider({
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
      }).pipe(withOAuthTestPlatform),
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
            Effect.sync(() => Option.getOrNull(MutableHashMap.get(vault, id))),
          write: (_provider, id, value) =>
            Effect.sync(() => {
              MutableHashMap.set(vault, id, value);
            }),
          remove: (_provider, id) =>
            Effect.sync(() => {
              MutableHashMap.remove(vault, id);
            }),
        };
        const legacy: CredentialStore = {
          read: () => Effect.succeed(null),
          write: () => Effect.void,
          remove: () => Effect.void,
        };
        const bound = yield* createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: () => Effect.succeed(fakeClient("openai")),
        });
        const pinnedA = yield* Scope.make();
        yield* Scope.provide(bound.forRun, pinnedA);
        yield* select(ids[1]);
        const pinnedB = yield* Scope.make();
        yield* Scope.provide(bound.forRun, pinnedB);
        yield* rejects(profiles.remove("openai", ids[0], accounts, legacy), "oauth_profile_in_use");
        expect(MutableHashMap.has(vault, ids[0])).toBe(true);
        yield* Scope.close(pinnedA, Exit.void);
        yield* Scope.close(pinnedA, Exit.void); // release is idempotent
        yield* profiles.remove("openai", ids[0], accounts, legacy);
        expect(MutableHashMap.has(vault, ids[0])).toBe(false);
        expect(MutableHashMap.has(vault, ids[1])).toBe(true);
        expect((yield* profiles.list("openai")).filter((p) => p.selected).map((p) => p.id)).toEqual(
          [ids[1]],
        );
        yield* rejects(profiles.remove("openai", ids[1], accounts, legacy), "oauth_profile_in_use");
        yield* Scope.close(pinnedB, Exit.void);
      }).pipe(withOAuthTestPlatform),
  );

  effectTest.live(
    "a pending vault deletion rejects a newly started run before any credential is removed",
    () =>
      Effect.gen(function* () {
        const { profiles } = yield* dbFixture();
        const reading = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(held, undefined));
        const credential: StoredCredential = {
          accessToken: "fake",
          refreshToken: "fake",
          expiresAt: 123,
        };
        const accounts: ProfileCredentialStore = {
          read: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(held);
              return credential;
            }),
          write: () => Effect.void,
          remove: () => Effect.void,
        };
        const legacy: CredentialStore = {
          read: () => Effect.succeed(null),
          write: () => Effect.void,
          remove: () => Effect.void,
        };
        const bound = yield* createAccountBoundSubscriptionClients({
          profiles,
          provider: "openai",
          createClient: () => Effect.succeed(fakeClient("openai")),
        });
        const removal = yield* Effect.forkChild(
          profiles.remove("openai", ids[0], accounts, legacy).pipe(Effect.uninterruptible),
        );
        yield* Deferred.await(reading);
        yield* rejects(Effect.scoped(bound.forRun), "oauth_profile_removing");
        yield* rejects(profiles.select("openai", ids[0], accounts), "oauth_profile_removing");
        yield* Deferred.succeed(held, undefined);
        yield* Fiber.join(removal);
        yield* Effect.scoped(bound.forRun); // fallback selected B can run
      }).pipe(withOAuthTestPlatform),
  );

  effectTest.live("leases are provider-scoped on the same database", () =>
    Effect.gen(function* () {
      const { profiles } = yield* dbFixture();
      yield* Effect.scoped(
        Effect.andThen(
          profiles.acquireRun("openai", ids[0]),
          profiles.acquireRun("anthropic", ids[0]),
        ),
      );
    }).pipe(withOAuthTestPlatform),
  );
});
