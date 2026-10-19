import { oauthProtocolCrypto } from "../oauth/node-runtime.ts";
import {
  Config,
  ConfigProvider,
  DateTime,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import {
  baselineProfile,
  defaultSettings,
  Experiment,
  Settings,
  Version,
  type HarnessProfile,
  type HarnessVersion,
  type ExperimentRecord,
} from "./contracts.ts";

export class HarnessStoreError extends Schema.TaggedError<HarnessStoreError>()(
  "HarnessStoreError",
  {
    reason: Schema.Literals(["integrity_failed", "frontier_changed", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const VersionJson = Schema.fromJsonString(Version);
const ExperimentJson = Schema.fromJsonString(Experiment);
const SettingsJson = Schema.fromJsonString(Settings);
const encodeVersion = Schema.encodeEffect(VersionJson);
const encodeExperiment = Schema.encodeEffect(ExperimentJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

export const profileHash = (profile: HarnessProfile) =>
  Buffer.from(
    Effect.runSync(
      oauthProtocolCrypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(profile))),
    ),
  ).toString("hex");

/** Storage and codec failures keep their cause; integrity and frontier refusals pass through. */
const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error: E): error is Exclude<E, HarnessStoreError> =>
      !Predicate.isTagged(error, "HarnessStoreError"),
    (cause) => Effect.fail(HarnessStoreError.make({ reason: "storage", cause })),
  );

export const makeHarnessStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readVersion = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ payload: VersionJson }),
    execute: (id) => sql`SELECT payload FROM rrsi_versions WHERE id=${id}`,
  });
  const readState = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ version_id: Schema.String, settings: SettingsJson }),
    execute: () => sql`SELECT version_id, settings FROM rrsi_state WHERE id=1`,
  });
  const readPin = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ version_id: Schema.String }),
    execute: (goalId) => sql`SELECT version_id FROM rrsi_goal_pins WHERE goal_id=${goalId}`,
  });
  const versionIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ payload: VersionJson }),
    execute: () => sql`SELECT payload FROM rrsi_versions ORDER BY rowid DESC`,
  });
  const recentExperiments = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ payload: ExperimentJson }),
    execute: () => sql`SELECT payload FROM rrsi_experiments ORDER BY rowid DESC LIMIT 30`,
  });
  const runningExperiments = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ payload: ExperimentJson }),
    execute: () =>
      sql`SELECT payload FROM rrsi_experiments WHERE json_extract(payload, '$.status')='running'`,
  });
  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  const get = (id: string) =>
    stored(
      readVersion(id).pipe(
        Effect.flatMap((row) =>
          Option.isSome(row) &&
          row.value.payload.artifactHash === profileHash(row.value.payload.profile)
            ? Effect.succeed(row.value.payload)
            : Effect.fail(HarnessStoreError.make({ reason: "integrity_failed" })),
        ),
      ),
    );
  const state = readState().pipe(
    Effect.flatMap((row) =>
      Effect.fromOption(row).pipe(
        Effect.mapError(() => HarnessStoreError.make({ reason: "integrity_failed" })),
      ),
    ),
  );
  const settings = stored(Effect.map(state, (row) => row.settings));
  const current = stored(Effect.flatMap(state, (row) => get(row.version_id)));
  const insertVersion = (version: HarnessVersion) =>
    encodeVersion(version).pipe(
      Effect.flatMap(
        (payload) => sql`INSERT INTO rrsi_versions VALUES (${version.id}, ${payload})`,
      ),
    );
  const setFrontier = (id: string) => sql`UPDATE rrsi_state SET version_id=${id} WHERE id=1`;

  yield* stored(
    Effect.gen(function* () {
      const base: HarnessVersion = {
        id: "baseline",
        parentId: null,
        profile: baselineProfile,
        kind: "profile",
        sourceCommit: null,
        artifactHash: profileHash(baselineProfile),
        createdAt: yield* nowMillis,
      };
      if (Option.isNone(yield* readVersion(base.id))) yield* insertVersion(base);
      yield* sql`INSERT OR IGNORE INTO rrsi_state VALUES (1, ${base.id}, ${yield* encodeSettings(defaultSettings)})`;
      yield* sql`INSERT OR IGNORE INTO rrsi_goal_pins
        SELECT goal_instance_id, 'baseline' FROM workflow_goal_identities`;
      // Interrupted local experiments have uncertain measurements, never auto-adopt them after restart.
      for (const { payload: prior } of yield* runningExperiments()) {
        const cancelled = yield* encodeExperiment({
          ...prior,
          status: "cancelled",
          finishedAt: yield* nowMillis,
          reason: "owner_restarted",
        });
        yield* sql`UPDATE rrsi_experiments SET payload=${cancelled} WHERE id=${prior.id}`;
      }
    }).pipe(sql.withTransaction),
  );

  return {
    get,
    current,
    settings,
    versions: stored(
      versionIds().pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => get(row.payload.id))),
      ),
    ),
    configure: (input: typeof Settings.Type) =>
      stored(
        encodeSettings(input).pipe(
          Effect.flatMap((encoded) => sql`UPDATE rrsi_state SET settings=${encoded} WHERE id=1`),
          Effect.asVoid,
        ),
      ),
    forGoal: (goalId: string | null) =>
      stored(
        Effect.gen(function* () {
          if (goalId === null || goalId.length === 0) {
            // Native host/SDK configuration boundary reads or forwards the host environment.
            const worker = yield* Config.String("CONTEXT_AGENT_RRSI_WORKER")
              .pipe(Config.withDefault(""))
              .parse(ConfigProvider.fromEnv());
            return worker === "1" ? yield* current : yield* get("baseline");
          }
          const saved = yield* readPin(goalId);
          if (Option.isSome(saved)) return yield* get(saved.value.version_id);
          // Old Goals retain baseline semantics even if their first run with this build is a resume.
          const version = yield* current;
          yield* sql`INSERT INTO rrsi_goal_pins VALUES (${goalId}, ${version.id})`;
          return version;
        }).pipe(sql.withTransaction),
      ),
    adopt: (profile: HarnessProfile, expected: string, sourceCommit: string | null = null) =>
      stored(
        Effect.gen(function* () {
          if ((yield* current).id !== expected)
            return yield* HarnessStoreError.make({ reason: "frontier_changed" });
          const version: HarnessVersion = {
            id: yield* oauthProtocolCrypto.randomUUIDv4(),
            parentId: expected,
            profile,
            kind: "profile",
            sourceCommit,
            artifactHash: profileHash(profile),
            createdAt: yield* nowMillis,
          };
          yield* insertVersion(version);
          yield* setFrontier(version.id);
          return version;
        }).pipe(sql.withTransaction),
      ),
    restore: (id: string) =>
      stored(get(id).pipe(Effect.andThen(setFrontier(id)), Effect.asVoid, sql.withTransaction)),
    saveExperiment: (record: ExperimentRecord) =>
      stored(
        // Encode when the save runs: encodeEffect snapshots its input, and a progress save that
        // finishes after the final one must still write the latest record.
        Effect.suspend(() => encodeExperiment(record)).pipe(
          Effect.flatMap(
            (payload) => sql`INSERT INTO rrsi_experiments VALUES (${record.id}, ${payload})
              ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
          ),
          Effect.asVoid,
        ),
      ),
    experiments: stored(
      recentExperiments().pipe(Effect.map((rows) => rows.map((row) => row.payload))),
    ),
  };
});

export class HarnessStore extends Context.Service<
  HarnessStore,
  Effect.Success<typeof makeHarnessStore>
>()("memory-agent/rrsi/store/HarnessStore") {
  static readonly layer = Layer.effect(HarnessStore, makeHarnessStore);
}
