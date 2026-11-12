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
  };
});

export class AgentSkills extends Context.Service<AgentSkills, Effect.Success<typeof make>>()(
  "memory-agent/skills/agent-skills/AgentSkills",
) {
  static readonly layer = Layer.effect(AgentSkills, make).pipe(Layer.provide(NodeCrypto.layer));
}
