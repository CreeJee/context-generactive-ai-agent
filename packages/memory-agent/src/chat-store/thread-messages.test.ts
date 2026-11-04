import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Database } from "../db/database.ts";
import { RunStore } from "../loop/store.ts";
import { StoredMessage } from "./schema.ts";
import { sqlAll, sqlExec, sqlRun } from "../../tests/support/sql.ts";
import { threadRevision, threadText, writeThread } from "../../tests/support/chat-thread.ts";

const fixture = <A, E>(program: Effect.Effect<A, E, RunStore | SqlClient.SqlClient>) =>
  Effect.scoped(
    Effect.flatMap(
      Layer.build(
        RunStore.layer.pipe(
          Layer.provideMerge(Layer.merge(Database.layer(":memory:"), NodeCrypto.layer)),
        ),
      ),
      (context) => Effect.provideContext(program, context),
    ),
  );

const encodeThread = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(StoredMessage)));
const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(StoredMessage));

const user = (id: string, content: string): StoredMessage => ({ id, role: "user", content });
const answer = (content: string): StoredMessage => ({ id: "answer", role: "assistant", content });
/** The answer once it made tool calls. */
const calling = (content: string, calls: ReadonlyArray<string>): StoredMessage => ({
  id: "answer",
  role: "assistant",
  content,
  toolCalls: calls.map((id) => ({
    id,
    type: "function",
    function: { name: "read", arguments: "{}" },
  })),
});
const result = (toolCallId: string): StoredMessage => ({
  role: "tool",
  toolCallId,
  content: `result ${toolCallId}`,
});

/** The positions each save wrote, recorded by a trigger the test adds. */
const written = Effect.map(sqlAll("SELECT seq FROM thread_message_writes ORDER BY rowid"), (rows) =>
  rows.map((row) => row.seq),
);

it.effect("saves rewrite only the messages from the first change, and read back as saved", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    yield* sqlExec(`
      CREATE TABLE thread_message_writes (seq INTEGER);
      CREATE TRIGGER thread_message_writes AFTER INSERT ON chat_thread_messages
      BEGIN INSERT INTO thread_message_writes VALUES (NEW.seq); END;
    `);
    /** Saves `messages` and checks what is stored and which positions were written. */
    const save = (messages: ReadonlyArray<StoredMessage>, kept: ReadonlyArray<StoredMessage>) =>
      Effect.gen(function* () {
        yield* sqlRun("DELETE FROM thread_message_writes");
        yield* store.saveThread("a", messages);
        expect(yield* store.thread("a")).toEqual(kept);
        expect(yield* threadText("a")).toBe(yield* encodeThread(kept));
        return yield* written;
      });
    const question = user("q", "Question");

    expect(yield* save([question, answer("Che")], [question, answer("Che")])).toEqual([0, 1]);
    // The snapshot a second later writes the answer again in its place.
    expect(yield* save([question, answer("Checking")], [question, answer("Checking")])).toEqual([
      1,
    ]);
    const step = [question, calling("Checking", ["c-1", "c-2"]), result("c-1"), result("c-2")];
    expect(yield* save(step, step)).toEqual([1, 2, 3]);
    // Unchanged: nothing is written.
    expect(yield* save(step, step)).toEqual([]);
    // A step that ends without the answer its snapshot saved: the rows past it go.
    expect(yield* save(step.slice(0, 2), step.slice(0, 2))).toEqual([]);
    // Resuming puts the results in the order of the calls.
    const resumed = [question, step[1]!, result("c-2"), result("c-1")];
    expect(yield* save(resumed, resumed)).toEqual([2, 3]);
    // Empty user text is never kept.
    const next = user("n", "Next");
    expect(yield* save([...resumed, user("e", ""), next], [...resumed, next])).toEqual([4]);
  }).pipe(fixture),
);

it.effect("a save compares with the thread as stored, not as its writer last saved it", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const sql = yield* SqlClient.SqlClient;
    const messages = [user("q", "token: secret"), answer("Done")];
    yield* store.saveThread("a", messages);
    // The secret sweep hides the first message in place, and a read gives what it left.
    yield* sqlRun(
      "UPDATE chat_thread_messages SET message = ? WHERE thread_id = 'a' AND seq = 0",
      yield* encodeMessage(user("q", "token: [redacted]")),
    );
    expect(yield* store.thread("a")).toEqual([user("q", "token: [redacted]"), answer("Done")]);
    // The run still holds the text it had and saves it with its next message.
    const next = [...messages, user("n", "Next")];
    yield* store.saveThread("a", next);
    expect(yield* store.thread("a")).toEqual(next);

    // A save whose transaction rolls back leaves the thread as it was, and the next save is whole.
    const rolledBack = [...next, user("r", "Rolled back")];
    yield* Effect.flip(
      sql.withTransaction(Effect.andThen(store.saveThread("a", rolledBack), Effect.fail("after"))),
    );
    expect(yield* store.thread("a")).toEqual(next);
    const after = [...next, user("s", "Saved")];
    yield* store.saveThread("a", after);
    expect(yield* store.thread("a")).toEqual(after);
    expect(yield* threadText("a")).toBe(yield* encodeThread(after));
  }).pipe(fixture),
);

it.effect(
  "a thread is given as remembered while it stays at the revision it was read or saved at",
  () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const question = user("q", "Question");
      // Another writer's thread is read once, then given as that read decoded it.
      yield* writeThread({
        threadId: "a",
        messages: yield* encodeThread([question, answer("Done")]),
      });
      const read = yield* store.thread("a");
      expect(yield* store.thread("a")).toBe(read);

      // A save builds on the remembered messages and is remembered as a read would decode it,
      // without a field the stored shape leaves out.
      const drafted = { ...user("n", "Next"), draft: true };
      yield* store.saveThread("a", [...read, drafted]);
      const saved = yield* store.thread("a");
      expect(saved).toEqual([question, answer("Done"), user("n", "Next")]);
      expect(saved[0]).toBe(read[0]);
      expect(yield* store.thread("a")).toBe(saved);

      // Only the threads saved or read last are remembered.
      yield* Effect.forEach(
        ["b", "c", "d", "e"],
        (threadId) => store.saveThread(threadId, [question]),
        {
          discard: true,
        },
      );
      const again = yield* store.thread("a");
      expect(again).not.toBe(saved);
      expect(again).toEqual(saved);
    }).pipe(fixture),
);

it.effect("a rolled-back save is not remembered, though the next change gets its revision", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const sql = yield* SqlClient.SqlClient;
    const question = user("q", "Question");
    yield* store.saveThread("a", [question]);
    const rolledBack = yield* sql
      .withTransaction(
        store.saveThread("a", [question, user("r", "Rolled back")]).pipe(
          Effect.andThen(threadRevision("a")),
          Effect.flatMap((revision) => Effect.fail(revision)),
        ),
      )
      .pipe(Effect.flip);

    yield* sqlRun(
      "INSERT INTO chat_thread_messages (thread_id, seq, message) VALUES ('a', 1, ?)",
      yield* encodeMessage(user("o", "Other")),
    );
    expect(yield* threadRevision("a")).toBe(rolledBack);
    expect(yield* store.thread("a")).toEqual([question, user("o", "Other")]);
  }).pipe(fixture),
);
