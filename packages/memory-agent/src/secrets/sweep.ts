import { isTruthy } from "../truthy.ts";
import { ignoreLogged } from "../runtime/logged-failures.ts";
import { DateTime, Semaphore } from "effect";
import { NodeWorker } from "@effect/platform-node";
import { Worker } from "node:worker_threads";
import {
  Array as Arr,
  Context,
  Data,
  Effect,
  Layer,
  Number as EffectNumber,
  Option,
  Schema,
  Stream,
} from "effect";
import { RpcClient } from "effect/rpc";
import { Nodes } from "../memory/nodes.ts";
import { SqlClient, SqlSchema } from "effect/sql";
import { Indexer } from "../memory/embedding/indexer.ts";
import { VectorIndex } from "../memory/embedding/vector-index.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../runtime/resources.ts";
import { RedactionFailed, type RedactKind, RedactRpcs } from "./redact-protocol.ts";
import type { Redaction } from "./redactor.ts";

/**
 * Which detector swept a table. Raise it when the rules start finding things they did not, and
 * every table is swept again from the start.
 */
export const sweepVersion = 1;

/** Rows looked at per transaction; redaction runs before it, so the database is held briefly. */
const batchSize = 200;

/** A text column outside `nodes` that can hold what a tool printed or a person pasted. */
interface Column {
  readonly name: string;
  /** Stored as JSON: secrets are hidden in its strings and the structure is kept. */
  readonly json: boolean;
}

/**
 * Where text is kept besides the nodes: the page's saved conversation, approval requests and the
 * arguments reviewed for them, queued messages, and subagent tasks and answers.
 */
const ColumnTable = Schema.Literals([
  "chat_thread_messages",
  "chat_interrupts",
  "permission_reviews",
  "queued_messages",
  "subagents",
  "interpretations",
]);
type ColumnTable = typeof ColumnTable.Type;

const columnTables = {
  chat_thread_messages: [{ name: "message", json: true }],
  chat_interrupts: [
    { name: "payload", json: true },
    { name: "response", json: true },
  ],
  permission_reviews: [{ name: "input", json: true }],
  queued_messages: [
    { name: "text", json: false },
    { name: "draft", json: false },
  ],
  subagents: [
    { name: "last_task", json: false },
    { name: "last_answer", json: false },
  ],
  interpretations: [{ name: "reason", json: false }],
} as const satisfies Record<ColumnTable, readonly Column[]>;

/** What one sweep covers; nodes and their references need more than a column update. */
type Target = Data.TaggedEnum<{
  nodes: {};
  refs: {};
  columns: { readonly table: ColumnTable };
}>;
const Target = Data.taggedEnum<Target>();

const targets: readonly Target[] = [
  Target.nodes(),
  Target.refs(),
  ...ColumnTable.literals.map((table) => Target.columns({ table })),
];

const targetName = Target.$match({
  nodes: () => "nodes" as const,
  refs: () => "refs" as const,
  columns: ({ table }) => table,
});

const Progress = Schema.Struct({
  version: Schema.Finite,
  after: Schema.Finite,
  done: Schema.Literals([0, 1]),
  hidden: Schema.Finite,
});
const decodeColumnRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);
/** Which row a mark is for and how many writes it counts; the row's columns are left out. */
const decodeMark = Schema.decodeUnknownEffect(
  Schema.Struct({ row_key: Schema.Finite, writes: Schema.Finite }),
);
const decodeCell = Schema.decodeUnknownEffect(Schema.NullOr(Schema.String));

/** A column value after sweeping; `null` stays `null`. */
interface SweptCell {
  readonly text: string | null;
  readonly hidden: number;
}

/** A row of a table rewritten in place, as the sweep read it, and what it hid in it. */
interface SweptRow {
  readonly rowid: number;
  /** How many writes the row had had since the sweep last read it, when this sweep read it. */
  readonly writes: number;
  /** The row's columns with their secrets hidden; none when it held no secret. */
  readonly values: Option.Option<Record<string, string | null>>;
}

export { RedactionFailed } from "./redact-protocol.ts";

/** Secrets hidden in a batch of texts, one redaction per text in order. */
type Redact = (
  kind: RedactKind,
  texts: readonly string[],
) => Effect.Effect<readonly Redaction[], RedactionFailed>;

/**
 * A redaction worker for one sweep, stopped when the sweep ends: a sweep runs once per start, and
 * the checks it needs stay loaded only while it runs.
 */
const redactionWorker = Effect.gen(function* () {
  const file = yield* runtimeWorker("redact-worker").pipe(
    Effect.mapError(() => RedactionFailed.make({ reason: "worker-lost" })),
  );
  const options = yield* runtimeWorkerOptions({});
  const workers = NodeWorker.layer(() => new Worker(file, options));
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(Layer.provide(workers)),
  );
  const client = yield* RpcClient.make(RedactRpcs).pipe(Effect.provideContext(protocol));
  const redact: Redact = (kind, texts) =>
    texts.length === 0
      ? Effect.succeed([])
      : client
          .Redact({ kind, texts })
          .pipe(
            Effect.catchTag("RpcClientError", () =>
              Effect.fail(RedactionFailed.make({ reason: "worker-lost" })),
            ),
          );
  return redact;
}).pipe(
  Effect.catchTag("WorkerError", () =>
    Effect.fail(RedactionFailed.make({ reason: "worker-lost" })),
  ),
);

/** One column's cells after sweeping, in order; a `null` cell is not sent and stays `null`. */
const redactCells = (redact: Redact, kind: RedactKind, cells: ReadonlyArray<string | null>) =>
  Effect.map(
    redact(
      kind,
      cells.filter((cell) => cell !== null),
    ),
    (redactions) => {
      const swept = redactions[Symbol.iterator]();
      return cells.map((cell): SweptCell =>
        cell === null
          ? { text: null, hidden: 0 }
          : (swept.next().value ?? { text: cell, hidden: 0 }),
      );
    },
  );

export interface SweepProgress {
  readonly target: string;
  readonly done: boolean;
  readonly hidden: number;
}

/** The sweep could not read or record its progress; it resumes from the last record next time. */
export class SweepStoreFailed extends Schema.TaggedError<
  SweepStoreFailed,
  { readonly brand: unique symbol }
>()("SweepStoreFailed", {
  cause: Schema.Defect(),
}) {}
const stored = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.mapError(effect, (cause) => SweepStoreFailed.make({ cause }));

const make = (running: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const indexer = yield* Indexer;
    const nodes = yield* Nodes;
    const vectors = yield* VectorIndex;
    const onePassAtATime = yield* Semaphore.make(1);

    const readProgress = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Progress,
      execute: (target) =>
        sql`SELECT version, after, done, hidden FROM secret_sweeps WHERE target = ${target}`,
    });
    const saveProgress = (target: Target, after: number, done: boolean, hidden: number) =>
      Effect.flatMap(
        DateTime.now,
        (now) => sql`
          INSERT INTO secret_sweeps ${sql.insert({
            target: targetName(target),
            version: sweepVersion,
            after,
            done: done ? 1 : 0,
            hidden,
            updated_at: DateTime.formatIso(now),
          })}
          ON CONFLICT (target) DO UPDATE SET version = excluded.version, after = excluded.after,
            done = excluded.done, hidden = excluded.hidden, updated_at = excluded.updated_at`,
      );

    /** A target's progress by this detector; a sweep by an older one counts as none. */
    const currentProgress = (target: Target) =>
      Effect.map(
        readProgress(targetName(target)),
        Option.filter((row) => row.version === sweepVersion),
      );

    const notStarted = { after: 0, done: 0, hidden: 0 };

    /** Where a target's sweep stands; a sweep by an older detector counts as not started. */
    const progressOf = (target: Target) =>
      Effect.map(
        currentProgress(target),
        Option.getOrElse(() => notStarted),
      );

    // Nodes: the text changes under a permit, and what was derived from the old text goes with it.
    const nodeBatch = SqlSchema.findAll({
      Request: Schema.Finite,
      Result: Schema.Struct({ seq: Schema.Finite, text: Schema.String }),
      execute: (after) =>
        sql`SELECT seq, text FROM nodes WHERE seq > ${after} ORDER BY seq LIMIT ${batchSize}`,
    });
    const rewriteNode = Effect.fnUntraced(function* (row: {
      readonly seq: number;
      readonly hidden: string;
    }) {
      yield* sql`INSERT INTO secret_sweep_permits VALUES (${row.seq})`;
      // The update is journaled for the lexical index, which takes the hidden text in its place.
      yield* sql`UPDATE nodes SET text = ${row.hidden} WHERE seq = ${row.seq}`;
      yield* sql`DELETE FROM secret_sweep_permits WHERE node_seq = ${row.seq}`;
      yield* sql`DELETE FROM node_vectors WHERE node_seq = ${row.seq}`;
    });

    const sweepNodes = (redact: Redact, after: number) =>
      Effect.gen(function* () {
        const rows = yield* stored(nodeBatch(after));
        const redactions = yield* redact(
          "text",
          rows.map((row) => row.text),
        );
        const changed = rows.flatMap((row, index) => {
          const redaction = redactions[index];
          return isTruthy(redaction) && redaction.hidden > 0
            ? [{ ...row, hidden: redaction.text }]
            : [];
        });
        // Under the indexer's permit, so no batch embeds a node between the vector
        // being dropped here and its text changing.
        yield* indexer.exclusive(
          Effect.gen(function* () {
            yield* Effect.when(
              // Saved before the database commits, as the indexer does: a crash in between leaves
              // the index and the table disagreeing on size, which reopening detects and rebuilds.
              vectors
                .remove(changed.map((row) => row.seq))
                .pipe(Effect.andThen(vectors.save), Effect.andThen(nodes.invalidateResultPages)),
              Effect.succeed(changed.length > 0),
            );
            yield* stored(
              Effect.forEach(changed, rewriteNode, { discard: true }).pipe(sql.withTransaction),
            );
          }),
        );
        return { rows: rows.length, last: rows.at(-1)?.seq ?? after, hidden: changed.length };
      });

    // References: a URL a call named. Replacing keeps the row; a clash with an identical, already
    // hidden reference of the same node just leaves that one.
    const refBatch = SqlSchema.findAll({
      Request: Schema.Finite,
      Result: Schema.Struct({ row_key: Schema.Finite, ref: Schema.String }),
      execute: (after) => sql`SELECT rowid AS row_key, ref FROM node_refs
        WHERE rowid > ${after} ORDER BY rowid LIMIT ${batchSize}`,
    });

    const sweepRefs = (redact: Redact, after: number) =>
      Effect.gen(function* () {
        const rows = yield* stored(refBatch(after));
        const redactions = yield* redact(
          "text",
          rows.map((row) => row.ref),
        );
        const changed = rows.flatMap((row, index) => {
          const redaction = redactions[index];
          return isTruthy(redaction) && redaction.hidden > 0
            ? [{ rowKey: row.row_key, ref: redaction.text }]
            : [];
        });
        yield* stored(
          Effect.forEach(
            changed,
            ({ rowKey, ref }) =>
              sql`UPDATE OR REPLACE node_refs SET ref = ${ref} WHERE rowid = ${rowKey}`,
            { discard: true },
          ).pipe(sql.withTransaction),
        );
        return { rows: rows.length, last: rows.at(-1)?.row_key ?? after, hidden: changed.length };
      });

    /**
     * Readies a table rewritten in place for its sweep. A detector that has not swept it yet reads
     * every row, so all are marked; marks of rows deleted since are dropped.
     */
    const markColumns = (table: ColumnTable, swept: boolean) =>
      Effect.andThen(
        Effect.when(
          sql`INSERT INTO secret_sweep_changes (target, row_key, writes)
            SELECT ${table}, rowid, 1 FROM ${sql.literal(table)} WHERE true
            ON CONFLICT DO UPDATE SET writes = writes + 1`,
          Effect.succeed(!swept),
        ),
        sql`DELETE FROM secret_sweep_changes WHERE target = ${table}
          AND row_key NOT IN (SELECT rowid FROM ${sql.literal(table)})`,
      );

    /**
     * Forgets a row the sweep read, and writes what it hid, only while nothing wrote the row since
     * the read. A newer write is kept as it is and swept on the next start. Returns whether the
     * row's secrets were hidden.
     */
    const settle = (table: ColumnTable) => (row: SweptRow) =>
      Effect.flatMap(
        sql`DELETE FROM secret_sweep_changes
          WHERE target = ${table} AND row_key = ${row.rowid} AND writes = ${row.writes}
          RETURNING row_key`,
        (forgotten) =>
          Option.match(
            Option.filter(row.values, () => forgotten.length > 0),
            {
              onNone: () => Effect.succeed(false),
              onSome: (values) =>
                sql`UPDATE ${sql.literal(table)} SET ${sql.update(values)} WHERE rowid = ${row.rowid}`.pipe(
                  // The sweep's own write marks the row again.
                  Effect.andThen(
                    sql`DELETE FROM secret_sweep_changes WHERE target = ${table} AND row_key = ${row.rowid}`,
                  ),
                  Effect.as(true),
                ),
            },
          ),
      );

    const sweepColumns = (redact: Redact, table: ColumnTable, after: number) =>
      Effect.gen(function* () {
        const columns: readonly Column[] = columnTables[table];
        const names = columns.map((column) => `t.${column.name} AS ${column.name}`);
        // Only the rows written since the sweep last read them.
        const rows = yield* stored(
          sql`SELECT c.row_key, c.writes, ${sql.literal(names.join(", "))}
            FROM secret_sweep_changes AS c JOIN ${sql.literal(table)} AS t ON t.rowid = c.row_key
            WHERE c.target = ${table} AND c.row_key > ${after}
            ORDER BY c.row_key LIMIT ${batchSize}`.pipe(Effect.flatMap(decodeColumnRows)),
        );
        const marks = yield* stored(Effect.forEach(rows, (row) => decodeMark(row)));
        const cells = yield* stored(
          Effect.forEach(rows, (row) =>
            Effect.forEach(columns, (column) => decodeCell(row[column.name])),
          ),
        );
        // One request per column rather than per cell: `swept[column][row]`.
        const swept = yield* Effect.forEach(columns, (column, index) =>
          redactCells(
            redact,
            column.json ? "json" : "text",
            cells.map((row) => row[index] ?? null),
          ),
        );
        const read = marks.map((mark, rowIndex): SweptRow => ({
          rowid: mark.row_key,
          writes: mark.writes,
          values: Option.map(
            Option.liftPredicate(
              swept.map((column) => column[rowIndex] ?? { text: null, hidden: 0 }),
              (cells) => cells.some((cell) => cell.hidden > 0),
            ),
            (cells) =>
              Object.fromEntries(
                columns.map((column, index) => [column.name, cells[index]?.text ?? null]),
              ),
          ),
        }));
        const hidden = yield* stored(Effect.forEach(read, settle(table)).pipe(sql.withTransaction));
        return {
          rows: rows.length,
          last: marks.at(-1)?.row_key ?? after,
          hidden: Arr.countBy(hidden, isTruthy),
        };
      });

    const batchOf = (redact: Redact, target: Target, after: number) =>
      Target.$match(target, {
        nodes: () => sweepNodes(redact, after),
        refs: () => sweepRefs(redact, after),
        columns: ({ table }) => sweepColumns(redact, table, after),
      });

    /**
     * Where a table's sweep starts this time.
     *
     * Nodes and references are only ever added, and what is added now is hidden on the way in, so
     * their sweep carries on from where it stopped — including rows added since, which is how text
     * written by an older build of this app is still caught.
     *
     * The other tables are rewritten in place (a run rewrites the message it is writing) and are
     * not all hidden on the way in, so a position means nothing for them. Their triggers mark each row
     * written since the sweep last read it, and every start reads the marked rows from the first.
     */
    const resumesFrom = (target: Target, saved: number) =>
      Target.$match(target, {
        nodes: () => saved,
        refs: () => saved,
        columns: () => 0,
      });

    /** Sweeps one table to the end, recording where it got after every batch. */
    const sweep = (redact: Redact, target: Target) =>
      Effect.gen(function* () {
        const current = yield* stored(currentProgress(target));
        const start = Option.getOrElse(current, () => notStarted);
        yield* stored(
          Target.$match(target, {
            nodes: () => Effect.void,
            refs: () => Effect.void,
            columns: ({ table }) => markColumns(table, Option.isSome(current)),
          }),
        );
        // A short batch is the table's last.
        const { sweptNow } = yield* Stream.paginate(resumesFrom(target, start.after), (after) =>
          Effect.map(
            batchOf(redact, target, after),
            (batch) =>
              [
                Arr.of(batch),
                batch.rows < batchSize ? Option.none<number>() : Option.some(batch.last),
              ] as const,
          ),
        ).pipe(
          Stream.runFoldEffect(
            () => ({ hidden: start.hidden, sweptNow: 0 }),
            (total, batch) => {
              const hidden = total.hidden + batch.hidden;
              return Effect.as(
                stored(saveProgress(target, batch.last, batch.rows < batchSize, hidden)),
                { hidden, sweptNow: total.sweptNow + batch.hidden },
              );
            },
          ),
        );
        return sweptNow;
      });

    /**
     * Sweeps what this detector has not seen. Nodes whose text changed are embedded and analysed
     * again afterwards, from the hidden text. Returns how many nodes changed.
     */
    const run = Effect.gen(function* () {
      const changedNodes = yield* Effect.scoped(
        Effect.gen(function* () {
          const redact = yield* redactionWorker;
          const hidden = yield* Effect.forEach(targets, (target) =>
            Effect.map(sweep(redact, target), (count) => (Target.$is("nodes")(target) ? count : 0)),
          );
          return EffectNumber.sumAll(hidden);
        }),
      );
      yield* Effect.when(
        // The hidden text is already stored; nodes left unindexed are indexed by the next pass. The
        // lexical index goes first: until it has the hidden text, reads drop those nodes' matches.
        Effect.all([indexer.lexicalAll(), indexer.indexAll()], { discard: true }).pipe(
          ignoreLogged("secret_sweep_reindex_failed"),
        ),
        Effect.succeed(changedNodes > 0),
      );
      return changedNodes;
    }).pipe(onePassAtATime.withPermits(1));

    // Progress is stored per target; the next start resumes a sweep that failed.
    yield* Effect.when(
      Effect.forkScoped(run.pipe(ignoreLogged("secret_sweep_failed"))),
      Effect.succeed(running),
    );

    return {
      run,
      progress: stored(
        Effect.forEach(targets, (target) =>
          Effect.map(progressOf(target), (saved): SweepProgress => ({
            target: targetName(target),
            done: saved.done === 1,
            hidden: saved.hidden,
          })),
        ),
      ),
    };
  });

/**
 * Hides secrets in stored text that was not hidden on the way in: nodes (and the search index,
 * morpheme terms and vectors made from them), references, the saved conversation, approvals,
 * queued messages and subagent records. Runs in the background on every start.
 */
export class SecretSweep extends Context.Service<
  SecretSweep,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/secrets/sweep/SecretSweep") {
  static readonly layer = (running: boolean = true) => Layer.effect(SecretSweep, make(running));
}
