import {
  Array as Arr,
  Context,
  Data,
  Effect,
  HashMap,
  HashSet,
  Iterable,
  Layer,
  Option,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { summaryCharacters } from "../agent/compaction-policy.ts";
import { asRunFailed, type RunHook, type StepRequest } from "../loop/run.ts";
import { replayedToolCallIds } from "../model/compatible.ts";
import { runTool } from "../tools/run-tool.ts";
import { changeAuthoritySql } from "./changes.ts";
import type { NodeLink } from "./edges.ts";
import { Nodes, NodeRow, nodeOfRow } from "./nodes.ts";

/**
 * A session's progress memo (docs/decisions.md 2026-11-13 "진행 중인 run도 줄이고, 진행 메모는
 * 근거와 함께 남긴다"): the agent's own notes of what it found, did, tried and left open, each resting
 * on memory nodes. Every entry is a `note` node that `cites` its evidence; changing or removing one
 * writes a later note that `supersedes` it, so nothing written is lost. The memo is shown at the end
 * of every request, so it outlasts what compaction leaves out.
 */

export const MemoKind = Schema.Literals(["found", "done", "tried", "open"]);
export type MemoKind = typeof MemoKind.Type;

/** One entry of a session's memo as it stands. */
export interface MemoEntry {
  readonly id: string;
  readonly kind: MemoKind;
  readonly text: string;
  /** The nodes it rests on. */
  readonly evidence: readonly string[];
  readonly runId: string | null;
  readonly createdAt: string;
  /** A later message of the user corrected or retracted it. */
  readonly changedByUser: boolean;
}

/** The run a memo is written from. */
export interface MemoBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
}

const entryFields = {
  kind: MemoKind.annotate({
    description:
      "found: something you learned. done: something you changed or ran. tried: an attempt and how it went. open: a question still open.",
  }),
  text: Schema.NonEmptyString.annotate({ description: "One short sentence." }),
  evidence: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyString).annotate({
      description:
        "What it rests on: tool call IDs from this conversation, or memory node IDs. Required unless kind is open. Not file:line: cite the call that read the file.",
    }),
  ),
};

const UpdateMemoInput = Schema.Struct({
  add: Schema.optionalKey(Schema.Array(Schema.Struct(entryFields))),
  replace: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString.annotate({ description: "The entry's ID in the memo." }),
        ...entryFields,
      }),
    ),
  ),
  remove: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyString).annotate({
      description: "IDs of entries that no longer hold or are no longer needed.",
    }),
  ),
});
type WrittenEntry = Schema.Struct.Type<typeof entryFields>;

const updateMemo = {
  name: "update_memo",
  description: `Keep this conversation's progress memo: what you found, did and tried, each with the evidence it rests on, and what is still open. The memo is shown at the end of every request and stays when older messages are left out, so keep it current and short (at most ${summaryCharacters} characters). Entries are your notes, not the user's words.`,
  parameters: UpdateMemoInput,
} as const;

/** What the memo says at the end of a request. */
export const memoText = (entries: ReadonlyArray<MemoEntry>) =>
  [
    "Progress memo: your own notes for this conversation, shown at the end of every request and kept when older messages are left out. They are not the user's words. Keep them current with update_memo.",
    ...entries.map(
      (entry) =>
        `- ${entry.kind} ${entry.id}: ${entry.text}${
          entry.evidence.length > 0 ? ` (evidence: ${entry.evidence.join(", ")})` : ""
        }${entry.changedByUser ? " (the user later corrected or retracted this)" : ""}`,
    ),
  ].join("\n");

/** The entries as a tool answer or a subagent's report gives them. */
export const memoView = (entries: ReadonlyArray<MemoEntry>) =>
  entries.map(({ id, kind, text, evidence }) => ({ id, kind, text, evidence }));

const lengthOf = (entries: ReadonlyArray<{ readonly text: string }>) =>
  Arr.reduce(entries, 0, (total, entry) => total + entry.text.length);

/** Some cited ids were not found yet; `found` holds those that were. */
class EvidencePending extends Data.TaggedError("EvidencePending")<{
  readonly found: HashMap.HashMap<string, string>;
}> {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const nodes = yield* Nodes;
  const oneAtATime = yield* Semaphore.make(1);
  const changeAuthority = sql.literal(changeAuthoritySql("s", "n"));

  const currentRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ ...NodeRow.fields, changed_by_user: Schema.Finite }),
    execute: (sessionId) => sql`
      SELECT n.*, EXISTS (SELECT 1 FROM edges e JOIN nodes s ON s.id = e.from_id
        WHERE e.to_id = n.id AND e.kind IN ('corrects', 'retracts') AND ${changeAuthority}
      ) AS changed_by_user
      FROM nodes n
      WHERE n.session_id = ${sessionId} AND n.kind = 'note'
        AND json_extract(n.detail, '$.memo') <> 'removed'
        AND NOT EXISTS (SELECT 1 FROM edges e JOIN nodes later ON later.id = e.from_id
          WHERE e.to_id = n.id AND e.kind = 'supersedes'
            AND later.session_id = n.session_id AND later.seq > n.seq)
      ORDER BY n.seq`,
  });
  const citesOf = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: Schema.Struct({ from_id: Schema.String, to_id: Schema.String }),
    execute: (ids) => sql`SELECT from_id, to_id FROM edges
      WHERE kind = 'cites' AND from_id IN ${sql.in(ids)} ORDER BY created_at, rowid`,
  });
  const projectNodes = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String, ids: Schema.Array(Schema.String) }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ projectId, ids }) =>
      sql`SELECT id FROM nodes WHERE id IN ${sql.in(ids)} AND project_id = ${projectId}`,
  });
  // Newest first, so the first recorded result of a call is the one a key keeps.
  const sessionResults = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ tool_call_id: Schema.String, id: Schema.String }),
    execute: (sessionId) => sql`
      SELECT json_extract(detail, '$.toolCallId') AS tool_call_id, id FROM nodes
      WHERE session_id = ${sessionId} AND kind = 'tool_result'
        AND json_extract(detail, '$.toolCallId') > ''
      ORDER BY seq DESC`,
  });

  /** The session's memo as it stands, oldest entry first. */
  const current = (sessionId: string) =>
    Effect.gen(function* () {
      const rows = yield* currentRows(sessionId);
      const cites = Arr.isReadonlyArrayNonEmpty(rows)
        ? yield* citesOf(rows.map((row) => row.id))
        : [];
      return rows.flatMap((row): MemoEntry[] => {
        const node = nodeOfRow(row);
        return Option.toArray(
          Option.map(Schema.decodeUnknownOption(MemoKind)(node.detail.memo), (kind): MemoEntry => ({
            id: node.id,
            kind,
            text: node.text,
            evidence: cites.filter((edge) => edge.from_id === node.id).map((edge) => edge.to_id),
            runId: node.runId,
            createdAt: node.createdAt,
            changedByUser: row.changed_by_user === 1,
          })),
        );
      });
    });

  /**
   * The node each cited id names: a node of the project as it is, or a tool call of this
   * conversation by its result, also under the id a replayed request gave it. A call's result is
   * recorded as its step ends, beside the run, so a call the model just read is looked for again a
   * few times.
   */
  const resolve = (binding: MemoBinding, cited: ReadonlyArray<string>) => {
    const asked = Arr.dedupe(cited);
    const lookup = Effect.gen(function* () {
      const asNodes = Arr.isReadonlyArrayNonEmpty(asked)
        ? yield* projectNodes({ projectId: binding.projectId, ids: asked })
        : [];
      const results = yield* sessionResults(binding.sessionId);
      const byCall = HashMap.fromIterable(
        Iterable.flatMap(results, ({ tool_call_id, id }) =>
          Iterable.map(
            [tool_call_id, ...replayedToolCallIds(tool_call_id)],
            (seen) => [seen, id] as const,
          ),
        ),
      );
      const found = HashMap.union(
        byCall,
        HashMap.fromIterable(Iterable.map(asNodes, ({ id }) => [id, id] as const)),
      );
      const inAsked = HashMap.filter(found, (_node, id) => asked.includes(id));
      return yield* asked.every((id) => HashMap.has(inAsked, id))
        ? Effect.succeed(inAsked)
        : Effect.fail(new EvidencePending({ found: inAsked }));
    });
    return lookup.pipe(
      Effect.retry({
        while: (failure) => failure._tag === "EvidencePending",
        schedule: Schedule.spaced("100 millis"),
        times: 10,
      }),
      Effect.catchTag("EvidencePending", ({ found }) => Effect.succeed(found)),
    );
  };

  const note = (
    binding: MemoBinding,
    memo: MemoKind | "removed",
    text: string,
    links: ReadonlyArray<NodeLink>,
  ) =>
    nodes.append({
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      runId: binding.runId,
      kind: "note",
      text,
      detail: { memo },
      links,
      // Written during a step, before the step's own calls are recorded.
      inFlow: false,
    });

  const cites = (entry: WrittenEntry, resolved: HashMap.HashMap<string, string>) =>
    Arr.dedupe(
      (entry.evidence ?? []).flatMap((id) => Option.toArray(HashMap.get(resolved, id))),
    ).map((nodeId): NodeLink => ({ kind: "cites", nodeId }));

  /** Applies a memo change, all of it or, when any part is refused, none of it. */
  const write = (binding: MemoBinding, input: typeof UpdateMemoInput.Type) =>
    Effect.gen(function* () {
      const before = yield* current(binding.sessionId);
      const known = HashSet.fromIterable(Iterable.map(before, (entry) => entry.id));
      const added = input.add ?? [];
      const replaced = input.replace ?? [];
      const removed = input.remove ?? [];
      const written: ReadonlyArray<WrittenEntry> = [...added, ...replaced];
      const resolved = yield* resolve(
        binding,
        written.flatMap((entry) => entry.evidence ?? []),
      );
      const gone = HashSet.fromIterable([...replaced.map((entry) => entry.id), ...removed]);
      const after =
        lengthOf(before.filter((entry) => !HashSet.has(gone, entry.id))) + lengthOf(written);
      const problems = [
        ...Arr.dedupe([...replaced.map((entry) => entry.id), ...removed])
          .filter((id) => !HashSet.has(known, id))
          .map((id) => `No entry ${id} in the memo.`),
        ...written
          .filter((entry) => entry.kind !== "open" && (entry.evidence ?? []).length === 0)
          .map((entry) => `"${entry.text}" needs evidence: only open entries go without.`),
        ...Arr.dedupe(written.flatMap((entry) => entry.evidence ?? []))
          .filter((id) => !HashMap.has(resolved, id))
          .map(
            (id) =>
              `Evidence ${id} is neither a tool call ID of this conversation nor a memory node ID of this project. For a file, cite the call that read it.`,
          ),
        ...(after > summaryCharacters && after > lengthOf(before)
          ? [
              `The memo would hold ${after} characters, over ${summaryCharacters}: replace or remove entries first.`,
            ]
          : []),
      ];
      if (Arr.isReadonlyArrayNonEmpty(problems))
        return { error: "memo_not_updated", problems } as const;
      yield* Effect.gen(function* () {
        yield* Effect.forEach(
          added,
          (entry) => note(binding, entry.kind, entry.text, cites(entry, resolved)),
          { discard: true },
        );
        yield* Effect.forEach(
          replaced,
          (entry) =>
            note(binding, entry.kind, entry.text, [
              ...cites(entry, resolved),
              { kind: "supersedes", nodeId: entry.id },
            ]),
          { discard: true },
        );
        yield* Effect.forEach(
          removed,
          (id) => note(binding, "removed", "removed", [{ kind: "supersedes", nodeId: id }]),
          { discard: true },
        );
      }).pipe(sql.withTransaction);
      return { memo: memoView(yield* current(binding.sessionId)) } as const;
    }).pipe(oneAtATime.withPermits(1));

  return {
    current,

    /** update_memo for a run of the session. */
    toolFor: (binding: MemoBinding) =>
      runTool({ ...updateMemo, handler: (input) => write(binding, input) }),

    /** Shows the session's memo at the end of each request, when it has one. */
    hookFor: (sessionId: string): RunHook => ({
      request: (_scope, request) =>
        current(sessionId).pipe(
          Effect.map((entries): StepRequest =>
            Arr.isReadonlyArrayNonEmpty(entries)
              ? {
                  ...request,
                  history: [
                    ...request.history,
                    { role: "user" as const, content: memoText(entries) },
                  ],
                }
              : request,
          ),
          Effect.mapError(asRunFailed),
        ),
    }),
  };
});

/** Each session's progress memo: notes the agent keeps with their evidence. */
export class ProgressMemos extends Context.Service<ProgressMemos, Effect.Success<typeof make>>()(
  "memory-agent/memory/progress-memo/ProgressMemos",
) {
  static readonly layer = Layer.effect(ProgressMemos, make);
}
