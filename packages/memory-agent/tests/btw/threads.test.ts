import { Crypto, Effect, FileSystem, Schema, Stream } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { Attachments } from "../../src/attachments/attachments.ts";
import { attachmentUrl } from "../../src/attachments/urls.ts";
import { BtwChat } from "../../src/btw/chat.ts";
import {
  BtwError,
  BtwParentNotFound,
  BtwThreadNotFound,
  btwToolNames,
} from "../../src/btw/contracts.ts";
import { AgUiEvent } from "../../src/loop/chunks.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import type { ScriptedResponder } from "../../src/testing/scripted-model.ts";
import { btwApi } from "../support/chat-api.ts";
import { tinyPng } from "../support/images.ts";
import { selectTestModel } from "../support/provider.ts";
import { freshSession, TestEnv, testAgent } from "../support/test-env.ts";
import { sqlGet } from "../support/sql.ts";

const question = Effect.fnUntraced(function* (text: string, imageIds: readonly string[]) {
  const crypto = yield* Crypto.Crypto;
  return {
    runId: `run-${yield* crypto.randomUUIDv4()}`,
    message: {
      id: yield* crypto.randomUUIDv4(),
      role: "user" as const,
      content: [
        { type: "text" as const, content: text },
        ...imageIds.map((id) => ({
          type: "image" as const,
          source: { type: "url" as const, value: attachmentUrl(id) },
        })),
      ],
    },
  };
});

const Count = Schema.Struct({ count: Schema.Finite });
const count = (sql: string, ...values: string[]) =>
  sqlGet(sql, ...values).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Count)),
    Effect.map((row) => row.count),
  );

/** Calls the tool its question names (`promote` asks for a write), then answers. */
const responder: ScriptedResponder = (invocation) => {
  const last = invocation.history.at(-1);
  if (last?.role === "tool") return { text: "BTW answer" };
  const wantsWrite = JSON.stringify(last).includes("promote");
  const [name, args] = wantsWrite
    ? ["promote_memory_candidate", { claimId: "c", taskId: "t" }]
    : ["find_memory", { query: "SQLite" }];
  return {
    toolCalls: [{ id: `call-${invocation.index}`, name, arguments: JSON.stringify(args) }],
  };
};

/** Asks through the API and gives the answer's text once its run ends. */
const ask = Effect.fn("btwTest.ask")(function* (
  threadId: string,
  text: string,
  images: readonly string[] = [],
) {
  const events = yield* (yield* btwApi).ask({
    params: { thread: threadId },
    payload: yield* question(text, images),
  });
  return yield* Stream.runFold(
    events,
    () => "",
    (answer, { data }) =>
      AgUiEvent.guards.TEXT_MESSAGE_CONTENT(data) ? answer + data.delta : answer,
  );
});

testAgent({ testProvider: { responder } })("BTW threads", (it) => {
  it.effect("refuse tools outside the read-only allowlist without running them", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const { provider } = yield* TestEnv;
      const thread = yield* (yield* BtwChat).create(yield* freshSession);
      yield* ask(thread.id, "promote it");
      const [first, second] = provider!.invocations.slice(-2);
      expect(first!.toolNames.toSorted()).toEqual([...btwToolNames].toSorted());
      expect(second!.history.at(-1)).toMatchObject({
        content: expect.stringContaining("Unknown tool: promote_memory_candidate"),
      });
      expect(yield* count("SELECT count(*) AS count FROM memory_candidates")).toBe(0);
    }),
  );

  it.effect("explicit delete removes messages, tool transcripts and BTW-only images", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const btw = yield* BtwChat;
      const attachments = yield* Attachments;
      const sessionId = yield* freshSession;
      const image = yield* attachments.save(tinyPng);
      const thread = yield* btw.create(sessionId);
      const kept = yield* btw.create(sessionId);
      yield* ask(thread.id, "look at this", [image.id]);
      expect(
        yield* count(
          "SELECT count(*) AS count FROM btw_attachments WHERE thread_id = ?",
          thread.id,
        ),
      ).toBe(1);

      yield* btw.remove(thread.id);
      expect(
        yield* count("SELECT count(*) AS count FROM btw_threads WHERE id = ?", thread.id),
      ).toBe(0);
      expect(
        yield* count(
          "SELECT count(*) AS count FROM btw_attachments WHERE thread_id = ?",
          thread.id,
        ),
      ).toBe(0);
      expect(yield* attachments.get(image.id)).toBeNull();
      expect(yield* (yield* FileSystem.FileSystem).exists(attachments.pathOf(image))).toBe(false);
      const missing = yield* Effect.flip(btw.remove(thread.id));
      expect(Schema.is(BtwError)(missing) && missing.reason).toBeInstanceOf(BtwThreadNotFound);

      // Deleting the main conversation takes its remaining BTW threads with it.
      const deleted = yield* (yield* AgentChat).deleteSession(
        sessionId,
        null,
        `delete-${sessionId}`,
      );
      expect(deleted._tag).toBe("completed");
      expect(yield* count("SELECT count(*) AS count FROM btw_threads WHERE id = ?", kept.id)).toBe(
        0,
      );
    }),
  );

  it.effect("answer from the main conversation as it is when asked", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const env = yield* TestEnv;
      const btw = yield* BtwChat;
      const nodes = yield* Nodes;
      const sessionId = yield* freshSession;
      const mainNode = (text: string) =>
        nodes.append({ projectId: env.project.id, sessionId, kind: "user", text });
      yield* mainNode("first main message");
      const orphan = yield* Effect.flip(btw.create("none"));
      expect(Schema.is(BtwError)(orphan) && orphan.reason).toBeInstanceOf(BtwParentNotFound);

      const thread = yield* btw.create(sessionId);
      expect(yield* ask(thread.id, "side question one")).toContain("BTW answer");
      yield* mainNode("second main message, written after the BTW opened");
      expect(yield* ask(thread.id, "side question two")).toContain("BTW answer");
      expect(env.provider!.invocations.at(-2)!.system.join("\n")).toContain("second main message");
      expect(yield* btw.list(sessionId)).toMatchObject([
        { id: thread.id, title: "side question one" },
      ]);
    }),
  );
});

testAgent({ testProvider: { responder } })("BTW non-collection", (it) => {
  it.effect(
    "reads the main conversation and memory but stays out of nodes, indexes and interpretation",
    () =>
      Effect.gen(function* () {
        yield* selectTestModel();
        const env = yield* TestEnv;
        yield* (yield* Nodes).append({
          projectId: env.project.id,
          sessionId: env.session.id,
          kind: "user",
          text: "저장소는 SQLite로 결정했다.",
        });
        yield* (yield* Indexer).indexAll();
        const before = {
          nodes: yield* count("SELECT count(*) AS count FROM nodes"),
          jobs: yield* count("SELECT count(*) AS count FROM interpret_jobs"),
        };

        const thread = yield* (yield* BtwChat).create(env.session.id);
        expect(yield* ask(thread.id, "btw-question-only-here")).toContain("BTW answer");
        const [first, second] = env.provider!.invocations.slice(-2);
        expect(first!.system.join("\n")).toContain("저장소는 SQLite로 결정했다.");
        expect(second!.history.at(-1)).toMatchObject({
          content: expect.stringContaining("SQLite"),
        });

        yield* env.reopen;
        const after = yield* env.use(
          Effect.gen(function* () {
            return {
              nodes: yield* count("SELECT count(*) AS count FROM nodes"),
              jobs: yield* count("SELECT count(*) AS count FROM interpret_jobs"),
              fts: yield* count(
                "SELECT count(*) AS count FROM nodes_fts WHERE nodes_fts MATCH ?",
                '"btw-question-only-here"',
              ),
              pending: yield* (yield* Indexer).pending,
              stored: yield* count(
                "SELECT count(*) AS count FROM btw_threads WHERE id = ? AND messages LIKE '%btw-question-only-here%' AND messages LIKE '%find_memory%'",
                thread.id,
              ),
            };
          }),
        );
        expect(after).toEqual({ ...before, fts: 0, pending: 0, stored: 1 });

        const reopened = yield* (yield* btwApi).messages({ params: { thread: thread.id } });
        expect(reopened[0]).toEqual({
          id: expect.any(String),
          role: "user",
          parts: [{ type: "text", content: "btw-question-only-here" }],
        });
      }),
  );
});
