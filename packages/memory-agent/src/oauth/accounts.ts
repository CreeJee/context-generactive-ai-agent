import {
  Context,
  Data,
  DateTime,
  Effect,
  HashMap,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { isTruthy } from "../truthy.ts";
import { SubscriptionAccountProvider } from "../providers/contracts.ts";
import type { OAuthProvider } from "./protocol.ts";
import {
  OAuthKeychain,
  StoredCredentialSchema,
  type CredentialStore,
  type OAuthHarnessError,
  type OAuthProfileIdRejected,
  type StoredCredential,
} from "./validation-harness.ts";

export interface OAuthProfile {
  readonly id: string;
  readonly provider: OAuthProvider;
  readonly label: string;
  readonly selected: boolean;
  readonly createdAt: number;
}

type ProfileCredentialFailure = OAuthHarnessError | OAuthProfileIdRejected;

export interface ProfileCredentialStore {
  readonly read: (
    provider: OAuthProvider,
    id: string,
  ) => Effect.Effect<StoredCredential | null, ProfileCredentialFailure>;
  readonly write: (
    provider: OAuthProvider,
    id: string,
    credential: StoredCredential,
  ) => Effect.Effect<void, ProfileCredentialFailure>;
  readonly remove: (
    provider: OAuthProvider,
    id: string,
  ) => Effect.Effect<void, ProfileCredentialFailure>;
}

/** A distinct OS keychain account per local profile; never place credentials in SQLite. */
export function createProfileCredentialStore(
  open: (id: string) => Effect.Effect<CredentialStore, OAuthProfileIdRejected>,
): ProfileCredentialStore {
  return {
    read: (provider, id) => Effect.flatMap(open(id), (store) => store.read(provider)),
    write: (provider, id, credential) =>
      Effect.flatMap(open(id), (store) => store.write(provider, credential)),
    remove: (provider, id) => Effect.flatMap(open(id), (store) => store.remove(provider)),
  };
}

/** A profile change the store refused; the reason is the stable code callers branch on. */
export class OAuthProfileRejected extends Schema.TaggedError<OAuthProfileRejected>()(
  "OAuthProfileRejected",
  {
    reason: Schema.Literals([
      "invalid_oauth_profile",
      "oauth_profile_missing_credential",
      "oauth_profile_not_found",
      "oauth_profile_removing",
      "oauth_profile_in_use",
      "oauth_profile_conflicting_credential",
      "oauth_profile_copy_unverified",
    ]),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The profile table or a keychain slot could not be read or written. */
export class OAuthProfileStoreFailed extends Schema.TaggedError<OAuthProfileStoreFailed>()(
  "OAuthProfileStoreFailed",
  { operation: Schema.Literals(["database", "keychain"]), cause: Schema.Defect() },
) {}

const rejected = (reason: OAuthProfileRejected["reason"]) => OAuthProfileRejected.make({ reason });
const keychain = <A>(operation: Effect.Effect<A, ProfileCredentialFailure>) =>
  Effect.mapError(operation, (cause) =>
    OAuthProfileStoreFailed.make({ operation: "keychain", cause }),
  );
const databaseFailed = (cause: SqlError.SqlError | Schema.SchemaError) =>
  Effect.fail(OAuthProfileStoreFailed.make({ operation: "database", cause }));

const profileIdPattern =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|legacy-(?:openai|anthropic))$/;
const legacyLabels = {
  openai: "ChatGPT (이전 계정)",
  anthropic: "Claude (이전 계정)",
} satisfies Record<OAuthProvider, string>;

const decodeProfiles = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      provider: SubscriptionAccountProvider,
      label: Schema.String,
      selected: Schema.Literals([0, 1]),
      created_at: Schema.Finite,
    }),
  ),
);
const decodeProviders = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ provider: SubscriptionAccountProvider })),
);
const encodeStoredCredential = Schema.encodeEffect(Schema.fromJsonString(StoredCredentialSchema));
/** Compares vault contents by their stored form; a credential that will not encode is a vault fault. */
const encodeCredential = (credential: StoredCredential) =>
  Effect.mapError(encodeStoredCredential(credential), (cause) =>
    OAuthProfileStoreFailed.make({ operation: "keychain", cause }),
  );

/** Committed profile metadata, read by synchronous SDK admission. */
interface ProfileSnapshot {
  readonly profiles: ReadonlyArray<OAuthProfile>;
  readonly legacyRemoved: ReadonlyArray<OAuthProvider>;
}

/** One provider's part of a snapshot. */
const providerSnapshot = (snapshot: ProfileSnapshot, provider: OAuthProvider) => ({
  profiles: snapshot.profiles.filter((profile) => profile.provider === provider),
  legacyRemoved: snapshot.legacyRemoved.includes(provider),
});

// Local server process only: no token or account label is retained. SQLite remains the source
// for persisted profiles; this transient guard protects vault removal during a live model run.
type ProfileRunState = Data.TaggedEnum<{
  active: { readonly count: number };
  removing: {};
}>;
const ProfileRunState = Data.taggedEnum<ProfileRunState>();
const runKey = (provider: OAuthProvider, id: string) => `${provider}:${id}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const vault = yield* OAuthKeychain;
  const keychainAccounts = createProfileCredentialStore(vault.profileStore);
  type DatabaseFailure = SqlError.SqlError | Schema.SchemaError;

  const load = Effect.gen(function* () {
    const rows = yield* decodeProfiles(
      yield* sql`SELECT id, provider, label, selected, created_at FROM oauth_profiles
        ORDER BY provider, created_at, id`,
    );
    const removed = yield* decodeProviders(
      yield* sql`SELECT provider FROM oauth_legacy_removed ORDER BY provider`,
    );
    const snapshot: ProfileSnapshot = {
      profiles: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        label: row.label,
        selected: row.selected === 1,
        createdAt: row.created_at,
      })),
      legacyRemoved: removed.map((row) => row.provider),
    };
    return snapshot;
  });
  const committed = yield* Ref.make(
    yield* Effect.catchTags(load, {
      SqlError: databaseFailed,
      SchemaError: databaseFailed,
    }),
  );
  /** Writes and the snapshot they publish commit together. */
  const commit = <A>(body: Effect.Effect<A, DatabaseFailure | OAuthProfileRejected>) =>
    body.pipe(
      Effect.tap(() => Effect.flatMap(load, (next) => Ref.set(committed, next))),
      sql.withTransaction,
      Effect.catchTags({ SqlError: databaseFailed, SchemaError: databaseFailed }),
    );
  const read = Effect.catchTags(load, { SqlError: databaseFailed, SchemaError: databaseFailed });

  const list = (provider?: OAuthProvider) =>
    Effect.map(read, (snapshot) =>
      provider === undefined
        ? [...snapshot.profiles]
        : snapshot.profiles.filter((profile) => profile.provider === provider),
    );
  const find = (provider: OAuthProvider, id: string) =>
    Effect.map(list(provider), (profiles) => profiles.find((profile) => profile.id === id));

  const runs = yield* SynchronizedRef.make(HashMap.empty<string, ProfileRunState>());
  const runState = (provider: OAuthProvider, id: string) =>
    Effect.map(SynchronizedRef.get(runs), (states) =>
      Option.getOrUndefined(HashMap.get(states, runKey(provider, id))),
    );
  const inUse = (provider: OAuthProvider, id: string) =>
    Effect.map(runState(provider, id), ProfileRunState.$is("active"));
  const removing = (provider: OAuthProvider, id: string) =>
    Effect.map(runState(provider, id), ProfileRunState.$is("removing"));

  /** Admission at run creation; the run holds the profile until its scope closes. */
  const acquireRun = (
    provider: OAuthProvider,
    id: string,
  ): Effect.Effect<void, OAuthProfileRejected, Scope.Scope> => {
    const name = runKey(provider, id);
    return Effect.acquireRelease(
      SynchronizedRef.modifyEffect(runs, (states) => {
        const current = Option.getOrUndefined(HashMap.get(states, name));
        const count = ProfileRunState.$is("active")(current) ? current.count : 0;
        return ProfileRunState.$is("removing")(current)
          ? Effect.fail(rejected("oauth_profile_removing"))
          : Effect.succeed([
              undefined,
              HashMap.set(states, name, ProfileRunState.active({ count: count + 1 })),
            ] as const);
      }),
      () =>
        SynchronizedRef.update(runs, (states) =>
          Option.match(Option.filter(HashMap.get(states, name), ProfileRunState.$is("active")), {
            onNone: () => states,
            onSome: (active) =>
              active.count <= 1
                ? HashMap.remove(states, name)
                : HashMap.set(states, name, ProfileRunState.active({ count: active.count - 1 })),
          }),
        ),
    );
  };

  /** Holds the removal gate for `use`; a live run or another removal of the provider refuses it. */
  const whileRemoving = <A, E, R>(
    provider: OAuthProvider,
    id: string,
    use: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      SynchronizedRef.modifyEffect(runs, (states) => {
        const state: ProfileRunState = ProfileRunState.removing();
        return Effect.gen(function* () {
          yield* Effect.when(
            Effect.fail(rejected("oauth_profile_in_use")),
            Effect.succeed(
              ProfileRunState.$is("active")(
                Option.getOrUndefined(HashMap.get(states, runKey(provider, id))),
              ),
            ),
          );
          yield* Effect.when(
            Effect.fail(rejected("oauth_profile_removing")),
            Effect.succeed(
              HashMap.some(
                states,
                (gate, entry) =>
                  entry.startsWith(`${provider}:`) && ProfileRunState.$is("removing")(gate),
              ),
            ),
          );
          return [state, HashMap.set(states, runKey(provider, id), state)] as const;
        });
      }),
      () => use,
      // Removes only this gate by identity; run states compare equal by structure.
      (state) =>
        SynchronizedRef.update(runs, (states) =>
          Option.exists(HashMap.get(states, runKey(provider, id)), (gate) => gate === state)
            ? HashMap.remove(states, runKey(provider, id))
            : states,
        ),
    );

  /** Publish an already-authenticated per-profile vault slot; leave the current selection untouched. */
  const publish = Effect.fn("OAuthProfiles.publish")(function* (
    provider: OAuthProvider,
    id: string,
    label: string,
    accounts: ProfileCredentialStore = keychainAccounts,
  ) {
    if (
      !profileIdPattern.test(id) ||
      id.startsWith("legacy-") ||
      !isTruthy(label.trim()) ||
      label.length > 80
    )
      return yield* rejected("invalid_oauth_profile");
    yield* keychain(accounts.read(provider, id)).pipe(
      Effect.filterOrFail(isTruthy, () => rejected("oauth_profile_missing_credential")),
    );
    const createdAt = DateTime.toEpochMillis(yield* DateTime.now);
    yield* commit(
      sql`INSERT INTO oauth_profiles(id, provider, label, selected, created_at)
        VALUES (${id}, ${provider}, ${label.trim()}, 0, ${createdAt})`,
    );
    return (yield* find(provider, id))!;
  });

  /** Selection is provider-scoped and committed atomically; vault contents are never copied. */
  const select = Effect.fn("OAuthProfiles.select")(function* (
    provider: OAuthProvider,
    id: string,
    accounts: ProfileCredentialStore = keychainAccounts,
  ) {
    const target = yield* find(provider, id).pipe(
      Effect.filterOrFail(isTruthy, () => rejected("oauth_profile_not_found")),
    );
    const refuseRemoving = Effect.when(
      Effect.fail(rejected("oauth_profile_removing")),
      removing(provider, id),
    );
    yield* refuseRemoving;
    yield* keychain(accounts.read(provider, id)).pipe(
      Effect.filterOrFail(isTruthy, () => rejected("oauth_profile_missing_credential")),
    );
    yield* commit(
      Effect.gen(function* () {
        yield* refuseRemoving;
        yield* sql`SELECT id FROM oauth_profiles
          WHERE id = ${id} AND provider = ${provider}`.pipe(
          Effect.filterOrFail(
            (found) => found.length > 0,
            () => rejected("oauth_profile_not_found"),
          ),
        );
        yield* sql`UPDATE oauth_profiles SET selected = 0
          WHERE provider = ${provider} AND selected = 1`;
        yield* sql`UPDATE oauth_profiles SET selected = 1 WHERE provider = ${provider} AND id = ${id}`;
      }),
    );
    const selected: OAuthProfile = { ...target, selected: true };
    return selected;
  });

  const rename = Effect.fn("OAuthProfiles.rename")(function* (
    provider: OAuthProvider,
    id: string,
    label: string,
  ) {
    if (!isTruthy(label.trim()) || label.length > 80)
      return yield* rejected("invalid_oauth_profile");
    yield* commit(
      sql`UPDATE oauth_profiles SET label = ${label.trim()}
        WHERE id = ${id} AND provider = ${provider} RETURNING id`.pipe(
        Effect.filterOrFail(
          (updated) => updated.length === 1,
          () => rejected("oauth_profile_not_found"),
        ),
      ),
    );
    return (yield* find(provider, id))!;
  });

  const remove = Effect.fn("OAuthProfiles.remove")(function* (
    provider: OAuthProvider,
    id: string,
    accounts: ProfileCredentialStore = keychainAccounts,
    legacy: CredentialStore = vault.store,
  ) {
    const profile = yield* find(provider, id).pipe(
      Effect.filterOrFail(isTruthy, () => rejected("oauth_profile_not_found")),
    );
    return yield* whileRemoving(
      provider,
      id,
      Effect.gen(function* () {
        // A removed selection moves to the first other account whose credential is still there.
        const fallback = Option.flatten(
          yield* Effect.when(
            Effect.flatMap(list(provider), (listed) =>
              Effect.findFirst(
                listed.filter((item) => item.id !== id),
                (candidate) =>
                  Effect.map(keychain(accounts.read(provider, candidate.id)), isTruthy),
              ),
            ),
            Effect.succeed(profile.selected),
          ),
        );
        yield* Effect.when(
          Effect.gen(function* () {
            // Persist explicit removal before touching either vault slot: auth polling must not
            // re-import the legacy credential if a keychain operation fails mid-removal.
            const removedAt = DateTime.toEpochMillis(yield* DateTime.now);
            yield* commit(
              sql`INSERT OR IGNORE INTO oauth_legacy_removed(provider, removed_at)
                VALUES (${provider}, ${removedAt})`,
            );
            yield* keychain(legacy.remove(provider));
          }),
          Effect.succeed(id === `legacy-${provider}`),
        );
        yield* keychain(accounts.remove(provider, id));
        yield* commit(
          Effect.gen(function* () {
            yield* sql`DELETE FROM oauth_profiles WHERE id = ${id} AND provider = ${provider}`;
            yield* Option.match(fallback, {
              onNone: () => Effect.void,
              onSome: (next) => sql`UPDATE oauth_profiles SET selected = 1
                WHERE id = ${next.id} AND provider = ${provider}`,
            });
          }),
        );
        return yield* list(provider);
      }),
    );
  });

  /** Copy first, verify the new slot, then publish secret-free metadata. Never delete the legacy slot. */
  const importLegacy = Effect.fn("OAuthProfiles.importLegacy")(function* (
    provider: OAuthProvider,
    accounts: ProfileCredentialStore = keychainAccounts,
    legacy: CredentialStore = vault.store,
  ) {
    const id = `legacy-${provider}`;
    if ((yield* read).legacyRemoved.includes(provider)) return null;
    const existing = yield* find(provider, id);
    const stored = yield* keychain(accounts.read(provider, id));
    if (isTruthy(existing) && isTruthy(stored)) return existing;
    const credential = yield* keychain(legacy.read(provider));
    if (!isTruthy(credential)) {
      if (isTruthy(existing)) return yield* rejected("oauth_profile_missing_credential");
      return null;
    }
    const expected = yield* encodeCredential(credential);
    if (isTruthy(stored) && (yield* encodeCredential(stored)) !== expected)
      return yield* rejected("oauth_profile_conflicting_credential");
    yield* Effect.when(
      keychain(accounts.write(provider, id, credential)),
      Effect.succeed(!isTruthy(stored)),
    );
    const verified = yield* keychain(accounts.read(provider, id));
    if (!isTruthy(verified) || (yield* encodeCredential(verified)) !== expected)
      return yield* rejected("oauth_profile_copy_unverified");
    const createdAt = DateTime.toEpochMillis(yield* DateTime.now);
    // No asynchronous work in this transaction. A second importer may win; the legacy slot survives either way.
    yield* commit(
      sql`INSERT OR IGNORE INTO oauth_profiles(id, provider, label, selected, created_at)
        SELECT ${id}, ${provider}, ${legacyLabels[provider]},
          NOT EXISTS (SELECT 1 FROM oauth_profiles WHERE provider = ${provider} AND selected = 1),
          ${createdAt}`,
    );
    return (yield* find(provider, id)) ?? null;
  });

  return {
    list,
    publish,
    select,
    rename,
    remove,
    importLegacy,
    /** SDK boundary: the last committed profiles of a provider, without a database read. */
    committed: (provider: OAuthProvider) => providerSnapshot(Ref.getUnsafe(committed), provider),
    /** The last committed profiles of a provider, without a database read. */
    snapshot: (provider: OAuthProvider) =>
      Effect.map(Ref.get(committed), (snapshot) => providerSnapshot(snapshot, provider)),
    acquireRun,
    inUse,
    removing,
    whileRemoving,
  };
});

/** Subscription account profiles: SQLite metadata, OS keychain slots and live-run guards. */
export class OAuthProfiles extends Context.Service<OAuthProfiles, Effect.Success<typeof make>>()(
  "memory-agent/oauth/accounts/OAuthProfiles",
) {
  static readonly layer = Layer.effect(OAuthProfiles, make);
}
