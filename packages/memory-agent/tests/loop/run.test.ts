import { DatabaseSync } from "node:sqlite";
import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Context, type Crypto, Deferred, Effect, Layer, Ref, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import { connectionContext } from "../../src/db/database.ts";
import { migrations } from "../../src/db/migrations.ts";
import type { AgUiEvent } from "../../src/loop/chunks.ts";
import type { ResumeEntry } from "../../src/loop/resume.ts";
import { RunFailed, runChat, type RunSpec } from "../../src/loop/run.ts";
import { RunStore } from "../../src/loop/store.ts";
import { makeScriptedModel, type ScriptedTurn } from "../../src/testing/scripted-model.ts";
import { runTool } from "../../src/tools/run-tool.ts";

/**
 * The run loop's order and bookkeeping (docs/effect-ai-migration.md step 4), which types cannot
 * check: a call waiting for approval does not hold the others back, the resume runs only the calls
 * that had no answer and keeps results in call order, a refused resume starts nothing, and a cut
 * run keeps what it wrote.
 */

const database = Effect.acquireRelease(
  Effect.sync(() => {
    const sqlite = new DatabaseSync(":memory:");
    for (const migration of migrations) sqlite.exec(migration);
    return sqlite;
  }),
  (sqlite) => Effect.sync(() => sqlite.close()),
);

/** `body` on a fresh database. */
const withRows = <A, E>(
  body: Effect.Effect<A, E, RunStore | SqlClient.SqlClient | Crypto.Crypto>,
) =>
  Effect.gen(function* () {
    const sql = yield* connectionContext(yield* database);
    const store = yield* Effect.provideContext(Layer.build(RunStore.layer), sql);
    const crypto = yield* Layer.build(NodeCrypto.layer);
    return yield* Effect.provideContext(body, Context.merge(Context.merge(sql, store), crypto));
  }).pipe(Effect.scoped);

const rows = (query: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.flatMap(
      sql.unsafe(query),
      Schema.decodeUnknownEffect(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
    ),
  );

const Path = Schema.Struct({ path: Schema.String });

/** A model scripted with `turns`, a read tool, and a write tool that needs approval. */
const harness = Effect.fnUntraced(function* (
  ...turns: readonly [ScriptedTurn, ...Array<ScriptedTurn>]
) {
  const { model, invocations } = yield* makeScriptedModel(turns);
  const ran = yield* Ref.make<ReadonlyArray<string>>([]);
  const record = (name: string) => (params: typeof Path.Type) =>
    Effect.as(
      Ref.update(ran, (all) => [...all, `${name} ${params.path}`]),
      {
        [name]: params.path,
      },
    );
  const spec: RunSpec<never> = {
    model,
    source: { provider: "scripted", api: "text", model: "scripted-1" },
    system: [],
    tools: [
      runTool({
        name: "read_file",
        description: "Read.",
        parameters: Path,
        handler: record("read"),
      }),
      runTool({
        name: "write_file",
        description: "Write.",
        parameters: Path,
        needsApproval: true,
        handler: record("write"),
      }),
    ],
    hooks: [],
    modelFailure: () => RunFailed.make({ message: "The model failed." }),
  };
  const run = (
    runId: string,
    conversation: ReadonlyArray<StoredMessage>,
    options: {
      readonly resume?: ReadonlyArray<ResumeEntry>;
      readonly cancel?: Effect.Effect<void>;
    } = {},
  ): Effect.Effect<ReadonlyArray<AgUiEvent>, never, RunStore | Crypto.Crypto> =>
    Stream.runCollect(
      runChat(spec, {
        threadId: "thread",
        runId,
        conversation,
        resume: options.resume ?? [],
        cancel: options.cancel ?? Effect.never,
      }),
    );
  return { run, ran: Ref.get(ran), invocations };
});

const user: StoredMessage = { role: "user", content: "go" };
const write = { id: "w1", name: "write_file", arguments: '{"path":"a"}' };
const read = { id: "r1", name: "read_file", arguments: '{"path":"b"}' };
const runs = rows("SELECT run_id, status, error FROM chat_runs ORDER BY rowid");

describe("run loop", () => {
  it.effect("runs the other calls while one waits, then the resume runs only that one", () =>
    withRows(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const { run, ran, invocations } = yield* harness(
          { toolCalls: [write, read] },
          { text: "done" },
        );

        expect((yield* run("run-1", [user])).at(-1)).toMatchObject({
          type: "RUN_FINISHED",
          outcome: { type: "interrupt", interrupts: [{ id: "approval_w1" }] },
        });
        expect(yield* ran).toEqual(["read b"]);
        const waiting = yield* store.thread("thread");
        expect(waiting.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);

        yield* run("run-2", waiting, {
          resume: [{ interruptId: "approval_w1", status: "resolved", payload: { approved: true } }],
        });
        expect(yield* ran).toEqual(["read b", "write a"]);
        const thread = yield* store.thread("thread");
        expect(
          thread.flatMap((message) => (message.role === "tool" ? [message.toolCallId] : [])),
        ).toEqual(["w1", "r1"]);
        expect(thread.at(-1)).toMatchObject({ role: "assistant", content: "done" });
        expect((yield* invocations).length).toBe(2);
        expect(yield* runs).toEqual([
          { run_id: "run-1", status: "interrupted", error: null },
          { run_id: "run-2", status: "completed", error: null },
        ]);
        expect(yield* rows("SELECT status FROM chat_interrupts")).toEqual([{ status: "resolved" }]);
      }),
    ),
  );

  it.effect("refuses a resume that does not answer the waiting call, and starts no run", () =>
    withRows(
      Effect.gen(function* () {
        const { run, ran } = yield* harness({ toolCalls: [write] });
        yield* run("run-1", [user]);
        const refused = (resume: ReadonlyArray<ResumeEntry>) => run("run-2", [user], { resume });

        expect(yield* refused([])).toEqual([
          {
            type: "RUN_ERROR",
            code: "unknown-interrupt",
            message:
              "Thread has pending interrupts; resume is required before accepting new input. Resume entries must resolve or cancel the complete interrupt batch.",
          },
        ]);
        expect(
          yield* refused([
            { interruptId: "approval_w1", status: "resolved", payload: { approved: "yes" } },
          ]),
        ).toEqual([
          {
            type: "RUN_ERROR",
            code: "invalid-payload",
            message:
              "Approval approval_w1 must be a boolean or decision envelope. One or more interrupt resolutions are invalid.",
          },
        ]);
        expect(yield* ran).toEqual([]);
        expect(yield* runs).toEqual([{ run_id: "run-1", status: "interrupted", error: null }]);
      }),
    ),
  );

  it.effect("keeps the answer a failed model call had written", () =>
    withRows(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const { run } = yield* harness({ text: "half", failAfterText: "provider text" });

        expect((yield* run("run-1", [user])).at(-1)).toEqual({
          type: "RUN_ERROR",
          message: "The model failed.",
        });
        expect((yield* store.thread("thread")).at(-1)).toMatchObject({
          role: "assistant",
          content: "half",
          stopReason: "error",
        });
        expect(yield* runs).toEqual([
          { run_id: "run-1", status: "failed", error: "The model failed." },
        ]);
      }),
    ),
  );

  it.effect("records a cancelled run as aborted", () =>
    withRows(
      Effect.gen(function* () {
        const asked = yield* Deferred.make<void>();
        const { run } = yield* harness({
          text: "never sent",
          waitFor: Effect.andThen(Deferred.succeed(asked, undefined), Effect.never),
        });

        const events = yield* run("run-1", [user], { cancel: Deferred.await(asked) });
        expect(events.map(({ type }) => type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
        expect(events.at(-1)).toMatchObject({ outcome: { type: "cancelled" } });
        expect(yield* runs).toEqual([{ run_id: "run-1", status: "aborted", error: null }]);
      }),
    ),
  );
});
