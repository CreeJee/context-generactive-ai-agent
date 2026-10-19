import { Effect, Array as EffectArray, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/**
 * Evidence from real use that a project could work better: what the user had to correct, tool
 * calls that kept failing there, and kanban cards that failed or were replanned.
 */
export const Signal = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("correction"),
    projectId: Schema.String,
    /** The user message that made the correction. */
    nodeId: Schema.String,
    text: Schema.String,
    /** The latest message it corrected. */
    corrected: Schema.String,
    createdAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("tool_failure"),
    projectId: Schema.String,
    nodeId: Schema.String,
    toolName: Schema.String,
    /** What failures of the same cause share; see {@link failureSignature}. */
    signature: Schema.String,
    excerpt: Schema.String,
    createdAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("card_failure"),
    projectId: Schema.String,
    goalInstanceId: Schema.String,
    cardId: Schema.String,
    failureStreak: Schema.Int,
    replans: Schema.Int,
    reason: Schema.NullOr(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("kind"));
export type Signal = typeof Signal.Type;

export class SignalsFailed extends Schema.TaggedError<SignalsFailed>()("SignalsFailed", {
  /** The database read or a stored row failed; `cause` has the SQL or decode error. */
  reason: Schema.Literals(["storage"]),
  cause: Schema.Defect(),
}) {}

const excerptLength = 400;
const deniedCommand = /^Permission to use (\S+) with command (?:cd \S+ && )?([^\s;|&]+)/u;
const exitLine = /^Exit code \d+$/u;

/**
 * The first meaningful line of a failed tool result with paths, quoted text and numbers made
 * generic, so failures of one cause group together. A denied permission keeps the tool and the
 * command it ran, because the same command keeps being denied for the same reason.
 */
export const failureSignature = (text: string) => {
  const first =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !exitLine.test(line)) ?? "";
  const denied = deniedCommand.exec(first);
  return denied !== null
    ? `permission denied: ${denied[1]} ${denied[2]}`
    : first
        .replace(/(["'`]).*?\1/gu, "<text>")
        .replace(/(?:~|\.{0,2})?(?:\/[\w.@+-]+)+/gu, "<path>")
        .replace(/\d+/gu, "<n>")
        .slice(0, 120);
};

const CorrectionRow = Schema.Struct({
  project_id: Schema.String,
  id: Schema.String,
  text: Schema.String,
  corrected: Schema.String,
  created_at: Schema.String,
});
const FailureRow = Schema.Struct({
  project_id: Schema.String,
  id: Schema.String,
  tool_name: Schema.NullOr(Schema.String),
  text: Schema.String,
  created_at: Schema.String,
});
const CardRow = Schema.Struct({
  project_id: Schema.String,
  goal_instance_id: Schema.String,
  card_id: Schema.String,
  failure_streak: Schema.Int,
  replans: Schema.Int,
  reason: Schema.NullOr(Schema.String),
});

/** The signals recorded in `projectIds` since `since` (ISO time); cards have no time and all count. */
export const collectSignals = Effect.fn("Improve.collectSignals")(function* (
  projectIds: EffectArray.NonEmptyReadonlyArray<string>,
  since: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const failed = (cause: SqlError.SqlError | Schema.SchemaError) =>
    SignalsFailed.make({ reason: "storage", cause });
  const rows =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
    (query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
      query.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema))),
        Effect.mapError(failed),
      );
  const [corrections, failures, cards] = yield* Effect.all(
    [
      // A message that corrects several nodes is one correction, paired with the latest of them.
      rows(CorrectionRow)(sql`SELECT project_id, id, text, corrected, created_at FROM (
          SELECT u.project_id, u.id, u.text, u.created_at, u.seq, t.text AS corrected,
            row_number() OVER (PARTITION BY u.id ORDER BY t.seq DESC) AS latest
          FROM edges e JOIN nodes u ON u.id = e.from_id JOIN nodes t ON t.id = e.to_id
          WHERE e.kind = 'corrects' AND u.kind = 'user'
            AND u.project_id IN ${sql.in(projectIds)} AND u.created_at >= ${since})
        WHERE latest = 1 ORDER BY seq`),
      rows(FailureRow)(sql`SELECT project_id, id, json_extract(detail, '$.toolName') AS tool_name,
          substr(text, 1, 2000) AS text, created_at
        FROM nodes
        WHERE kind = 'tool_result' AND json_extract(detail, '$.ok') = 0
          AND project_id IN ${sql.in(projectIds)} AND created_at >= ${since}
        ORDER BY seq`),
      rows(CardRow)(sql`SELECT g.project_id, c.goal_instance_id, c.card_id, c.failure_streak,
          c.replans, c.reason
        FROM kanban_cards c JOIN kanban_goals g ON g.goal_instance_id = c.goal_instance_id
        WHERE (c.failure_streak > 0 OR c.replans > 0) AND g.project_id IN ${sql.in(projectIds)}`),
    ],
    { concurrency: "unbounded" },
  );
  return [
    ...corrections.map((row): Signal => ({
      kind: "correction",
      projectId: row.project_id,
      nodeId: row.id,
      text: row.text.slice(0, excerptLength),
      corrected: row.corrected.slice(0, excerptLength),
      createdAt: row.created_at,
    })),
    ...failures.map((row): Signal => ({
      kind: "tool_failure",
      projectId: row.project_id,
      nodeId: row.id,
      toolName: row.tool_name ?? "unknown",
      signature: failureSignature(row.text),
      excerpt: row.text.slice(0, excerptLength),
      createdAt: row.created_at,
    })),
    ...cards.map((row): Signal => ({
      kind: "card_failure",
      projectId: row.project_id,
      goalInstanceId: row.goal_instance_id,
      cardId: row.card_id,
      failureStreak: row.failure_streak,
      replans: row.replans,
      reason: row.reason,
    })),
  ];
});
