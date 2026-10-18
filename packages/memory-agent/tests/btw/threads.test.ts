import { Cause, Effect, FileSystem, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { Attachments } from "../../src/attachments/attachments.ts";
import { attachmentUrl } from "../../src/attachments/urls.ts";
import { BtwChat } from "../../src/btw/chat.ts";
import { btwToolNames } from "../../src/btw/contracts.ts";
import { btwToolGuard } from "../../src/btw/tools.ts";
import { Database } from "../../src/db/database.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { randomUUID } from "../../src/runtime/synchronous-crypto.ts";
import type { ScriptedResponder } from "../../src/testing/scripted-adapter.ts";
import { tinyPng } from "../support/images.ts";
import { selectTestModel } from "../support/provider.ts";
import { freshSession, TestEnv, testAgent } from "../support/test-env.ts";

const sdk = <A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

const btwRequest = (text: string, imageIds: readonly string[] = []) =>
  new Request("http://127.0.0.1/api/btw/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "page-thread",
      runId: `run-${randomUUID()}`,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: [
            { type: "text", content: text },
            ...imageIds.map((id) => ({
              type: "image",
              source: { type: "url", value: attachmentUrl(id) },
            })),
          ],
        },
      ],
      // A changed request cannot bring tools of its own.
      tools: [{ name: "write_file", description: "write", parameters: {} }],
      context: [],
    }),
  });

const Count = Schema.Struct({ count: Schema.Finite });
const count = (sql: string, ...values: string[]) =>
  Effect.flatMap(Database, ({ sqlite }) =>
    Schema.decodeUnknownEffect(Count)(sqlite.prepare(sql).get(...values)),
  ).pipe(Effect.map((row) => row.count));

/** Calls the tool its question names (`promote` asks for a write), then answers. */
const responder: ScriptedResponder = (invocation) => {
  const last = invocation.messages.at(-1);
  if (last?.role === "tool") return { text: "BTW answer" };
  const wantsWrite = JSON.stringify(last).includes("promote");
  const [name, args] = wantsWrite
    ? ["promote_memory_candidate", { claimId: "c", taskId: "t" }]
    : ["find_memory", { query: "SQLite" }];
  return {
    toolCalls: [{ id: `call-${randomUUID()}`, name, arguments: JSON.stringify(args) }],
  };
};

const ask = Effect.fn("btwTest.ask")(function* (
  threadId: string,
  text: string,
  images: readonly string[] = [],
) {
  const response = yield* (yield* BtwChat).handle(btwRequest(text, images), threadId);
  expect(response.status).toBe(200);
  return yield* sdk(() => response.text());
});

testAgent({ testProvider: { responder } })("BTW threads", (it) => {
  it.effect("refuse tools outside the read-only allowlist without running them", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const { provider } = yield* TestEnv;
      const thread = yield* (yield* BtwChat).create(yield* freshSession);
      yield* ask(thread.id, "promote it");
      const [first, second] = provider!.adapter.invocations.slice(-2);
      expect(first!.toolNames.toSorted()).toEqual([...btwToolNames].toSorted());
      expect(second!.messages.at(-1)).toMatchObject({
        content: expect.stringContaining("Unknown tool: promote_memory_candidate"),
      });
      expect(yield* count("SELECT count(*) AS count FROM memory_candidates")).toBe(0);

      // Even a write tool that reached the request is dropped, and a call to it is skipped.
      const writeTool = { name: "write_file", description: "write" };
      const findTool = { name: "find_memory", description: "find" };
      // SAFETY: the guard reads neither hook's middleware context, only the config and call.
      const ctx = {} as Parameters<NonNullable<typeof btwToolGuard.onConfig>>[0];
      expect(
        yield* sdk(() =>
          btwToolGuard.onConfig!(ctx, {
            messages: [],
            systemPrompts: [],
            tools: [findTool, writeTool],
          }),
        ),
      ).toEqual({ tools: [findTool] });
      expect(
        yield* sdk(() =>
          btwToolGuard.onBeforeToolCall!(ctx, {
            toolCall: {
              id: "w",
              type: "function",
              function: { name: "write_file", arguments: "{}" },
            },
            tool: writeTool,
            args: {},
            toolName: "write_file",
            toolCallId: "w",
          }),
        ),
      ).toEqual({ type: "skip", result: { error: "btw_tool_not_allowed", tool: "write_file" } });
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
      expect(attachments.get(image.id)).toBeNull();
      expect(yield* (yield* FileSystem.FileSystem).exists(attachments.pathOf(image))).toBe(false);
      expect(yield* Effect.flip(btw.remove(thread.id))).toMatchObject({
        reason: { _tag: "BtwThreadNotFound" },
      });

      // Deleting the main conversation takes its remaining BTW threads with it.
      const deleted = yield* (yield* AgentChat).deleteSession(
        sessionId,
        null,
        `delete-${sessionId}`,
      );
      expect(deleted.status).toBe(200);
      expect(yield* count("SELECT count(*) AS count FROM btw_threads WHERE id = ?", kept.id)).toBe(
        0,
      );
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
        (yield* Nodes).append({
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
        const [first, second] = env.provider!.adapter.invocations.slice(-2);
        expect(first!.systemPrompts.join("\n")).toContain("저장소는 SQLite로 결정했다.");
        expect(second!.messages.at(-1)).toMatchObject({
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

        const hydrated = yield* env.use(
          Effect.flatMap(BtwChat, (chat) =>
            chat.hydrate(new Request(`http://127.0.0.1/api/btw?threadId=${thread.id}`), thread.id),
          ),
        );
        expect(yield* sdk(() => hydrated.text())).toContain("btw-question-only-here");
      }),
  );
});
