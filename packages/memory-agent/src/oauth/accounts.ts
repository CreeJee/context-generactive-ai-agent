import { Context, DateTime, Effect, Layer, MutableHashMap, Option, Ref, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { isTruthy } from "../truthy.ts";
import { SubscriptionAccountProvider } from "../providers/contracts.ts";
import type { OAuthProvider } from "./protocol.ts";
import {
  StoredCredentialSchema,
  createKeychainCredentialStore,
  createKeychainProfileCredentialStore,
  type CredentialStore,
  type StoredCredential,
} from "./validation-harness.ts";

export interface OAuthProfile {
  readonly id: string;
  readonly provider: OAuthProvider;
  readonly label: string;
  readonly selected: boolean;
  readonly createdAt: number;
}

export interface ProfileCredentialStore {
  read(provider: OAuthProvider, id: string): Promise<StoredCredential | null>;
  write(provider: OAuthProvider, id: string, credential: StoredCredential): Promise<void>;
  remove(provider: OAuthProvider, id: string): Promise<void>;
}

/** A distinct OS keychain account per local profile; never place credentials in SQLite. */
export function createProfileCredentialStore(
  open: (id: string) => CredentialStore = createKeychainProfileCredentialStore,
): ProfileCredentialStore {
  return {
    read: (provider, id) => open(id).read(provider),
    write: (provider, id, credential) => open(id).write(provider, credential),
    remove: (provider, id) => open(id).remove(provider),
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
const keychain = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => OAuthProfileStoreFailed.make({ operation: "keychain", cause }),
  });
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

// Local server process only: no token or account label is retained. SQLite remains the source
// for persisted profiles; this transient guard protects vault removal during a live model run.
type ProfileRunState =
  | { readonly status: "active"; readonly count: number }
  | { readonly status: "removing" };
const runKey = (provider: OAuthProvider, id: string) => `${provider}:${id}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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

  const runs = MutableHashMap.empty<string, ProfileRunState>();
  const runState = (provider: OAuthProvider, id: string) =>
    Option.getOrUndefined(MutableHashMap.get(runs, runKey(provider, id)));
  const inUse = (provider: OAuthProvider, id: string) =>
    runState(provider, id)?.status === "active";
  const removing = (provider: OAuthProvider, id: string) =>
    runState(provider, id)?.status === "removing";

  /** Synchronous admission at run creation, an SDK boundary. Always call the release. */
  const acquireRun = (provider: OAuthProvider, id: string): (() => void) => {
    const name = runKey(provider, id);
    const current = runState(provider, id);
    let count = 0;
    switch (current?.status) {
      case "removing":
        throw rejected("oauth_profile_removing");
      case "active":
        count = current.count;
        break;
      case undefined:
        break;
    }
    MutableHashMap.set(runs, name, { status: "active", count: count + 1 });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const active = Option.getOrUndefined(MutableHashMap.get(runs, name));
      switch (active?.status) {
        case "active":
          if (active.count <= 1) MutableHashMap.remove(runs, name);
          else MutableHashMap.set(runs, name, { status: "active", count: active.count - 1 });
          break;
        default:
          break;
      }
    };
  };

  /** Holds the removal gate for `use`; a live run or another removal of the provider refuses it. */
  const whileRemoving = <A, E, R>(
    provider: OAuthProvider,
    id: string,
    use: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (inUse(provider, id)) return Effect.fail(rejected("oauth_profile_in_use"));
        if (
          [...runs].some(
            ([entry, state]) => entry.startsWith(`${provider}:`) && state.status === "removing",
          )
        )
          return Effect.fail(rejected("oauth_profile_removing"));
        const state: ProfileRunState = { status: "removing" };
        MutableHashMap.set(runs, runKey(provider, id), state);
        return Effect.succeed(state);
      }),
      () => use,
      (state) =>
        Effect.sync(() => {
          if (Option.getOrUndefined(MutableHashMap.get(runs, runKey(provider, id))) === state)
            MutableHashMap.remove(runs, runKey(provider, id));
        }),
    );

  /** Publish an already-authenticated per-profile vault slot; leave the current selection untouched. */
  const publish = Effect.fn("OAuthProfiles.publish")(function* (
    provider: OAuthProvider,
    id: string,
    label: string,
    accounts: ProfileCredentialStore = createProfileCredentialStore(),
  ) {
    if (
      !profileIdPattern.test(id) ||
      id.startsWith("legacy-") ||
      !isTruthy(label.trim()) ||
      label.length > 80
    )
      return yield* rejected("invalid_oauth_profile");
    yield* keychain(() => accounts.read(provider, id)).pipe(
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
    accounts: ProfileCredentialStore = createProfileCredentialStore(),
  ) {
    const target = yield* find(provider, id).pipe(
      Effect.filterOrFail(isTruthy, () => rejected("oauth_profile_not_found")),
    );
    if (removing(provider, id)) return yield* rejected("oauth_profile_removing");
    yield* keychain(() => accounts.read(provider, id)).pipe(
      Effect.filterOrFail(isTruthy, () => rejected("oauth_profile_missing_credential")),
    );
    yield* commit(
      Effect.gen(function* () {
        if (removing(provider, id)) return yield* rejected("oauth_profile_removing");
        const found = yield* sql`SELECT id FROM oauth_profiles
          WHERE id = ${id} AND provider = ${provider}`;
        if (found.length === 0) return yield* rejected("oauth_profile_not_found");
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
    accounts: ProfileCredentialStore = createProfileCredentialStore(),
    legacy: CredentialStore = createKeychainCredentialStore(),
  ) {
    const profile = yield* find(provider, id).pipe(
      Effect.filterOrFail(isTruthy, () => rejected("oauth_profile_not_found")),
    );
    return yield* whileRemoving(
      provider,
      id,
      Effect.gen(function* () {
        let fallback: OAuthProfile | undefined;
        if (profile.selected) {
          for (const candidate of (yield* list(provider)).filter((item) => item.id !== id)) {
            if (isTruthy(yield* keychain(() => accounts.read(provider, candidate.id)))) {
              fallback = candidate;
              break;
            }
          }
        }
        if (id === `legacy-${provider}`) {
          // Persist explicit removal before touching either vault slot: auth polling must not
          // re-import the legacy credential if a keychain operation fails mid-removal.
          const removedAt = DateTime.toEpochMillis(yield* DateTime.now);
          yield* commit(
            sql`INSERT OR IGNORE INTO oauth_legacy_removed(provider, removed_at)
              VALUES (${provider}, ${removedAt})`,
          );
          yield* keychain(() => legacy.remove(provider));
        }
        yield* keychain(() => accounts.remove(provider, id));
        yield* commit(
          Effect.gen(function* () {
            yield* sql`DELETE FROM oauth_profiles WHERE id = ${id} AND provider = ${provider}`;
            if (fallback !== undefined)
              yield* sql`UPDATE oauth_profiles SET selected = 1
                WHERE id = ${fallback.id} AND provider = ${provider}`;
          }),
        );
        return yield* list(provider);
      }),
    );
  });

  /** Copy first, verify the new slot, then publish secret-free metadata. Never delete the legacy slot. */
  const importLegacy = Effect.fn("OAuthProfiles.importLegacy")(function* (
    provider: OAuthProvider,
    accounts: ProfileCredentialStore = createProfileCredentialStore(),
    legacy: CredentialStore = createKeychainCredentialStore(),
  ) {
    const id = `legacy-${provider}`;
    if ((yield* read).legacyRemoved.includes(provider)) return null;
    const existing = yield* find(provider, id);
    const stored = yield* keychain(() => accounts.read(provider, id));
    if (isTruthy(existing) && isTruthy(stored)) return existing;
    const credential = yield* keychain(() => legacy.read(provider));
    if (!isTruthy(credential)) {
      if (isTruthy(existing)) return yield* rejected("oauth_profile_missing_credential");
      return null;
    }
    const expected = yield* encodeCredential(credential);
    if (isTruthy(stored) && (yield* encodeCredential(stored)) !== expected)
      return yield* rejected("oauth_profile_conflicting_credential");
    if (!isTruthy(stored)) yield* keychain(() => accounts.write(provider, id, credential));
    const verified = yield* keychain(() => accounts.read(provider, id));
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
    committed: (provider: OAuthProvider) => {
      const snapshot = Ref.getUnsafe(committed);
      return {
        profiles: snapshot.profiles.filter((profile) => profile.provider === provider),
        legacyRemoved: snapshot.legacyRemoved.includes(provider),
      };
    },
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
