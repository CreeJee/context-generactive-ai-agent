import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  Array as EffectArray,
  Clock,
  Context,
  Data,
  DateTime,
  Effect,
  HashSet,
  Iterable,
  Layer,
  Option,
  Order,
  Schema,
} from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";
import { SqlClient, SqlSchema } from "effect/sql";

/**
 * Skills the app keeps in its own storage, apart from any git checkout (decisions.md "에이전트가
 * 저장한 스킬은 앱 저장소에 후보로 두고, 검토를 통과한 것만 정식 스킬로 올린다 (2026-11-12)"):
 *
 * - A candidate is a skill `save_code_skill` saved; only the runs of the conversation that saved
 *   it see it. A Goal's cards and verifiers run in the Goal's conversation, so they share it.
 * - A promoted skill passed a review; every run of the project sees it.
 *
 * `git clean`, a stash or a branch switch in the user's folder leaves both as they are.
 */

/** A skill folder's text files by their path inside the folder: SKILL.md, scripts/run.sh, …. */
export const SkillFiles = Schema.Record(Schema.String, Schema.String);
export type SkillFiles = typeof SkillFiles.Type;

/** How a candidate came: saved by a conversation, or found in the user's skill folder. */
export const CandidateOrigin = Schema.Literals(["saved", "outside", "edited"]);
export type CandidateOrigin = typeof CandidateOrigin.Type;

export type StoredSkill = Data.TaggedEnum<{
  candidate: {
    readonly name: string;
    readonly files: SkillFiles;
    readonly contentSha256: string;
  };
  promoted: {
    readonly name: string;
    readonly files: SkillFiles;
    readonly contentSha256: string;
  };
}>;
export const StoredSkill = Data.taggedEnum<StoredSkill>();

const CandidateRow = Schema.Struct({
  name: Schema.String,
  files_json: Schema.fromJsonString(SkillFiles),
  content_sha256: Schema.String,
});
const PromotedRow = CandidateRow;

const ProjectSkillKey = Schema.Struct({ projectId: Schema.String, sessionId: Schema.String });

/** A candidate a review has not read as it is now, with the recorded runs of its content. */
const UnreviewedRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  origin: CandidateOrigin,
  files: Schema.fromJsonString(SkillFiles),
  contentSha256: Schema.String,
  runs: Schema.Int,
});
export type UnreviewedCandidate = typeof UnreviewedRow.Type;

/** A skill folder in the user's folder that the app found and keeps as a candidate. */
export interface FoundFolder {
  readonly name: string;
  readonly files: SkillFiles;
}

/** Found in the user's folder: a skill another agent or the user wrote, or a changed copy. */
export type FoundOrigin = Exclude<CandidateOrigin, "saved">;

/** A promoted skill with the content the app last copied to the user's folder. */
const PromotedCopyRow = Schema.Struct({
  name: Schema.String,
  files: Schema.fromJsonString(SkillFiles),
  contentSha256: Schema.String,
  copySha256: Schema.NullOr(Schema.String),
});
export type PromotedCopy = typeof PromotedCopyRow.Type;

const FoundRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contentSha256: Schema.String,
});

/** One run_skill call of a candidate as the model read its result. */
export interface SkillRun {
  readonly name: string;
  readonly toolCallId: string;
  readonly failed: boolean;
  readonly result: string;
}

const RunRow = Schema.Struct({ failed: Schema.BooleanFromBit, result: Schema.String });
export type RecordedRun = typeof RunRow.Type;

/** Recorded runs a review reads, the newest. */
const shownRuns = 8;

const byName = Order.mapInput(Order.String, (skill: StoredSkill) => skill.name);
const byPath = Order.mapInput(Order.String, (entry: readonly [string, string]) => entry[0]);
const encodeEntries = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
);
const encodeFiles = Schema.encodeEffect(Schema.fromJsonString(SkillFiles));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;

  const now = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );

  /** The same files always hash the same: paths in order, each with its text. */
  const contentSha256 = Effect.fnUntraced(function* (files: SkillFiles) {
    const entries = EffectArray.sort(Object.entries(files), byPath);
    const text = yield* encodeEntries(entries);
    return Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(text)));
  });

  const selectCandidates = SqlSchema.findAll({
    Request: ProjectSkillKey,
    Result: CandidateRow,
    execute: ({ projectId, sessionId }) => sql`
      SELECT name, files_json, content_sha256 FROM skill_candidates
      WHERE project_id = ${projectId} AND session_id = ${sessionId}`,
  });
  const selectUnreviewed = SqlSchema.findAll({
    Request: ProjectSkillKey,
    Result: UnreviewedRow,
    execute: ({ projectId, sessionId }) => sql`
      WITH counted AS (
        SELECT c.*, (SELECT count(*) FROM skill_runs r
          WHERE r.candidate_id = c.id AND r.content_sha256 = c.content_sha256) AS runs
        FROM skill_candidates c
        WHERE c.project_id = ${projectId} AND c.session_id = ${sessionId})
      SELECT id, name, origin, files_json AS files, content_sha256 AS contentSha256, runs
      FROM counted
      WHERE reviewed_sha256 IS NOT content_sha256 OR runs > reviewed_runs
      ORDER BY name`,
  });
  const selectUnreviewedFound = SqlSchema.findAll({
    Request: Schema.String,
    Result: UnreviewedRow,
    execute: (projectId) => sql`
      SELECT id, name, origin, files_json AS files, content_sha256 AS contentSha256, 0 AS runs
      FROM skill_candidates
      WHERE project_id = ${projectId} AND session_id IS NULL
        AND reviewed_sha256 IS NOT content_sha256
      ORDER BY name`,
  });
  const selectFound = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String, origin: CandidateOrigin }),
    Result: FoundRow,
    execute: ({ projectId, origin }) => sql`
      SELECT id, name, content_sha256 AS contentSha256 FROM skill_candidates
      WHERE project_id = ${projectId} AND session_id IS NULL AND origin = ${origin}`,
  });
  const selectPromotedCopies = SqlSchema.findAll({
    Request: Schema.String,
    Result: PromotedCopyRow,
    execute: (projectId) => sql`
      SELECT name, files_json AS files, content_sha256 AS contentSha256, copy_sha256 AS copySha256
      FROM promoted_skills WHERE project_id = ${projectId} ORDER BY name`,
  });
  const selectRuns = SqlSchema.findAll({
    Request: Schema.Struct({ candidateId: Schema.String, contentSha256: Schema.String }),
    Result: RunRow,
    execute: ({ candidateId, contentSha256 }) => sql`
      SELECT failed, result FROM skill_runs
      WHERE candidate_id = ${candidateId} AND content_sha256 = ${contentSha256}
      ORDER BY ran_at DESC, rowid DESC LIMIT ${shownRuns}`,
  });
  const upsertPromoted = SqlSchema.findOne({
    Request: Schema.Struct({
      projectId: Schema.String,
      name: Schema.String,
      files: Schema.String,
      contentSha256: Schema.String,
      reason: Schema.String,
      at: Schema.String,
    }),
    Result: Schema.Struct({ copy_sha256: Schema.NullOr(Schema.String) }),
    execute: (row) => sql`
      INSERT INTO promoted_skills
        (project_id, name, files_json, content_sha256, reason, promoted_at)
      VALUES (${row.projectId}, ${row.name}, ${row.files}, ${row.contentSha256}, ${row.reason},
        ${row.at})
      ON CONFLICT (project_id, name) DO UPDATE SET files_json = excluded.files_json,
        content_sha256 = excluded.content_sha256, reason = excluded.reason,
        promoted_at = excluded.promoted_at
      RETURNING copy_sha256`,
  });
  const selectPromoted = SqlSchema.findAll({
    Request: Schema.String,
    Result: PromotedRow,
    execute: (projectId) => sql`
      SELECT name, files_json, content_sha256 FROM promoted_skills WHERE project_id = ${projectId}`,
  });

  return {
    contentSha256,

    /**
     * The skills a run sees: the conversation's candidates, then the promoted skills their names
     * leave. Without a conversation (the settings page), only the promoted ones.
     */
    visible: Effect.fn("AgentSkills.visible")(function* (
      projectId: string,
      sessionId: string | undefined,
    ) {
      const promoted = (yield* selectPromoted(projectId)).map((row) =>
        StoredSkill.promoted({
          name: row.name,
          files: row.files_json,
          contentSha256: row.content_sha256,
        }),
      );
      const candidates =
        sessionId === undefined
          ? []
          : (yield* selectCandidates({ projectId, sessionId })).map((row) =>
              StoredSkill.candidate({
                name: row.name,
                files: row.files_json,
                contentSha256: row.content_sha256,
              }),
            );
      const taken = HashSet.fromIterable(Iterable.map(candidates, (skill) => skill.name));
      return EffectArray.sort(
        [...candidates, ...promoted.filter((skill) => !HashSet.has(taken, skill.name))],
        byName,
      );
    }),

    /**
     * Saves a conversation's candidate, replacing its earlier one of the same name. Returns
     * whether one was there.
     */
    saveCandidate: Effect.fn("AgentSkills.saveCandidate")(function* (input: {
      readonly projectId: string;
      readonly sessionId: string;
      readonly name: string;
      readonly files: SkillFiles;
    }) {
      const sha = yield* contentSha256(input.files);
      const at = yield* now;
      const id = yield* random.uuidV7();
      const files = yield* encodeFiles(input.files);
      const existing = yield* sql`
        SELECT 1 FROM skill_candidates
        WHERE project_id = ${input.projectId} AND session_id = ${input.sessionId}
          AND name = ${input.name}`;
      yield* sql`
        INSERT INTO skill_candidates
          (id, project_id, name, session_id, origin, files_json, content_sha256, created_at, updated_at)
        VALUES (${id}, ${input.projectId}, ${input.name}, ${input.sessionId}, 'saved', ${files},
          ${sha}, ${at}, ${at})
        ON CONFLICT (project_id, session_id, name) WHERE session_id IS NOT NULL
        DO UPDATE SET files_json = excluded.files_json, content_sha256 = excluded.content_sha256,
          updated_at = excluded.updated_at`;
      return { contentSha256: sha, replaced: existing.length > 0 };
    }),

    /**
     * Records run_skill calls of the conversation's candidates, each against the candidate's
     * content now. A call recorded before stays as it was; a name with no candidate records nothing.
     */
    recordRuns: Effect.fn("AgentSkills.recordRuns")(function* (
      projectId: string,
      sessionId: string,
      runs: ReadonlyArray<SkillRun>,
    ) {
      const at = yield* now;
      yield* Effect.forEach(
        runs,
        (run) => sql`
          INSERT OR IGNORE INTO skill_runs
            (candidate_id, tool_call_id, content_sha256, failed, result, ran_at)
          SELECT id, ${run.toolCallId}, content_sha256, ${run.failed ? 1 : 0}, ${run.result}, ${at}
          FROM skill_candidates
          WHERE project_id = ${projectId} AND session_id = ${sessionId} AND name = ${run.name}`,
        { discard: true },
      );
    }),

    /**
     * The conversation's candidates no review has read as they are now: saved or changed since,
     * or run again since.
     */
    unreviewed: (projectId: string, sessionId: string) =>
      selectUnreviewed({ projectId, sessionId }),

    /** The skill folders found in the user's folder that no review has read as they are now. */
    unreviewedFound: (projectId: string) => selectUnreviewedFound(projectId),

    /** The project's promoted skills with what the app last copied to the user's folder. */
    promotedCopies: (projectId: string) => selectPromotedCopies(projectId),

    /**
     * Makes the project's found candidates of `origin` the folders found now: one gone, or changed
     * since, leaves with its review, and one new or changed comes in unreviewed.
     */
    syncFound: Effect.fn("AgentSkills.syncFound")(function* (
      projectId: string,
      origin: FoundOrigin,
      found: ReadonlyArray<FoundFolder>,
    ) {
      const at = yield* now;
      const rows = yield* Effect.forEach(found, (folder) =>
        Effect.all({
          folder: Effect.succeed(folder),
          sha: contentSha256(folder.files),
          files: encodeFiles(folder.files),
          id: random.uuidV7(),
        }),
      );
      const current = HashSet.fromIterable(
        Iterable.map(rows, (row) => `${row.folder.name}\n${row.sha}`),
      );
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const stale = (yield* selectFound({ projectId, origin })).filter(
            (row) => !HashSet.has(current, `${row.name}\n${row.contentSha256}`),
          );
          yield* Effect.forEach(
            stale,
            (row) => sql`DELETE FROM skill_candidates WHERE id = ${row.id}`,
            { discard: true },
          );
          yield* Effect.forEach(
            rows,
            ({ folder, sha, files, id }) => sql`
              INSERT OR IGNORE INTO skill_candidates
                (id, project_id, name, session_id, origin, files_json, content_sha256, created_at,
                  updated_at)
              VALUES (${id}, ${projectId}, ${folder.name}, NULL, ${origin}, ${files}, ${sha},
                ${at}, ${at})`,
            { discard: true },
          );
        }),
      );
    }),

    /** The recorded runs of a candidate's content, newest first. */
    runsOf: (candidateId: string, contentSha256: string) =>
      selectRuns({ candidateId, contentSha256 }),

    /** Keeps a candidate as it is, with the review's reason, unless it changed meanwhile. */
    keep: (candidate: UnreviewedCandidate, reason: string) =>
      Effect.flatMap(now, (at) =>
        Effect.asVoid(sql`
          UPDATE skill_candidates SET reviewed_sha256 = ${candidate.contentSha256},
            reviewed_runs = ${candidate.runs}, kept_reason = ${reason}, reviewed_at = ${at}
          WHERE id = ${candidate.id} AND content_sha256 = ${candidate.contentSha256}`),
      ),

    /**
     * Moves a candidate to the project's promoted skills, replacing a promoted one of its name,
     * unless it changed meanwhile. When it moved, returns the content the app last copied to the
     * user's folder for that name, if it copied one.
     */
    promote: Effect.fn("AgentSkills.promote")(function* (
      projectId: string,
      candidate: UnreviewedCandidate,
      reason: string,
    ) {
      const at = yield* now;
      const files = yield* encodeFiles(candidate.files);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const moved = yield* sql`
            DELETE FROM skill_candidates
            WHERE id = ${candidate.id} AND content_sha256 = ${candidate.contentSha256}
            RETURNING id`;
          if (moved.length === 0) return Option.none<Option.Option<string>>();
          const copied = yield* upsertPromoted({
            projectId,
            name: candidate.name,
            files,
            contentSha256: candidate.contentSha256,
            reason,
            at,
          });
          return Option.some(Option.fromNullishOr(copied.copy_sha256));
        }),
      );
    }),

    /** Notes the content the app wrote to the user's folder for a promoted skill. */
    copied: (projectId: string, name: string, contentSha256: string) =>
      Effect.asVoid(sql`
        UPDATE promoted_skills SET copy_sha256 = ${contentSha256}
        WHERE project_id = ${projectId} AND name = ${name}`),
  };
});

export class AgentSkills extends Context.Service<AgentSkills, Effect.Success<typeof make>>()(
  "memory-agent/skills/agent-skills/AgentSkills",
) {
  static readonly layer = Layer.effect(AgentSkills, make).pipe(Layer.provide(NodeCrypto.layer));
}
