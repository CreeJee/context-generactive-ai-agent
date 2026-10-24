import { Effect, MutableRef, Option, Schedule, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat, attachmentInstructions } from "../../src/agent/chat.ts";
import { sessionMessages } from "../../src/agent/history.ts";
import { Attachments } from "../../src/attachments/attachments.ts";
import { attachmentUrl } from "../../src/attachments/urls.ts";
import { GlobalConfig } from "../../src/config/global-config.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { tinyPng } from "../support/images.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { freshSession, invocationsOf, json, openTab, sdk, until } from "./tab.ts";
import { sqlGet, sqlRun } from "../support/sql.ts";

type Content = string | readonly object[];

/** POST one user message straight to AgentChat, as a page without a client would. */
const post = Effect.fnUntraced(function* (sessionId: string, content: Content) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    threadId: "thread-ui",
    runId: `${sessionId}-run`,
    messages: [{ id: "m1", role: "user", content }],
    tools: [],
    context: [],
  });
  return yield* (yield* AgentChat).handle(
    new Request("http://127.0.0.1/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    sessionId,
  );
});

/** Count the provider's account releases for the rest of the test. */
const countReleases = Effect.gen(function* () {
  const { adapter } = (yield* TestEnv).provider!;
  const released = MutableRef.make(0);
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      Object.assign(adapter, { releaseRun: () => void MutableRef.increment(released) }),
    ),
    () => Effect.sync(() => Reflect.deleteProperty(adapter, "releaseRun")),
  );
  return () => MutableRef.get(released);
});

const imagePart = Effect.fnUntraced(function* () {
  const attachment = yield* (yield* Attachments).save(tinyPng);
  return {
    attachment,
    part: {
      type: "image",
      source: { type: "url", value: attachmentUrl(attachment.id), mimeType: "image/png" },
    } as const,
  };
});

const inlineImage = {
  type: "image",
  source: { type: "data", value: expect.any(String), mimeType: expect.stringMatching(/^image\//) },
};

testAgent({ testProvider: {} })("AgentChat.handle", (it) => {
  it.effect("rejects empty user text before creating evidence or a run", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const sessionId = yield* freshSession;
      const response = yield* post(sessionId, "");
      expect(response.status).toBe(400);
      expect(yield* json(response)).toEqual({ error: "empty_message" });
      expect({
        runs: (yield* sqlGet(
          "SELECT count(*) AS count FROM chat_runs WHERE thread_id = ?",
          sessionId,
        ))?.count,
        users: (yield* sqlGet(
          "SELECT count(*) AS count FROM nodes WHERE session_id = ? AND kind = 'user'",
          sessionId,
        ))?.count,
      }).toEqual({ runs: 0, users: 0 });
    }),
  );

  it.effect.each([{ run: "streamed" }, { run: "model_mismatch" }] as const)(
    "releases a pinned account exactly once when the run is $run",
    ({ run }) =>
      Effect.gen(function* () {
        yield* selectTestModel();
        const sessionId = yield* freshSession;
        switch (run) {
          case "streamed": {
            const released = yield* countReleases;
            const response = yield* post(sessionId, "hello");
            expect(response.status).toBe(200);
            // Only after the durable SSE stream finishes.
            yield* sdk(() => response.text());
            expect(released()).toBe(1);
            break;
          }
          case "model_mismatch": {
            yield* (yield* GlobalConfig).update({
              provider: "openai",
              model: "not-in-new-account",
              reasoningEffort: "low",
            });
            const released = yield* countReleases;
            const response = yield* post(sessionId, "hello");
            // Early, before streaming.
            expect(response.status).toBe(409);
            expect(yield* json(response)).toMatchObject({ error: "model_unavailable_for_account" });
            expect(released()).toBe(1);
            break;
          }
        }
      }),
  );

  it.effect("answers from memory through provider tools, records the run and indexes it", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const { project } = yield* TestEnv;
      const nodes = yield* Nodes;
      const indexer = yield* Indexer;
      const earlier = yield* nodes.append({
        projectId: project.id,
        sessionId: yield* freshSession,
        kind: "user",
        text: "저장소는 SQLite로 결정했다.",
      });
      yield* indexer.indexAll();
      const sessionId = yield* freshSession;

      const response = yield* post(sessionId, "what did we decide? remember");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      const Delta = Schema.fromJsonString(
        Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
      );
      const events = yield* Effect.forEach(
        (yield* sdk(() => response.text())).split("\n").filter((line) => line.startsWith("data: ")),
        (line) => Schema.decodeEffect(Delta)(line.slice(6)),
      );
      expect(
        events
          .flatMap((event) =>
            event.type === "TEXT_MESSAGE_CONTENT" && event.delta !== undefined ? [event.delta] : [],
          )
          .join(""),
      ).toBe("Found: 저장소는 SQLite로 결정했다.");

      const recorded = yield* nodes.session(sessionId);
      expect(recorded.map((node) => node.kind)).toEqual([
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "assistant",
      ]);
      expect(recorded[3]!.text).toContain(earlier.id);

      // Indexing runs in the background after the run; wait for it to catch up.
      const indexed = yield* indexer.pending.pipe(
        Effect.repeat({ until: (remaining) => remaining === 0, schedule: Schedule.spaced(20) }),
        Effect.timeoutOption(1_000),
      );
      expect(Option.isSome(indexed)).toBe(true);
    }),
  );

  it.effect("hides Work Trace behind a reversible exposure flag without deleting shadow data", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const agent = yield* AgentChat;
      const config = yield* GlobalConfig;
      const agentId = `${sessionId}-flag-agent`;
      yield* sqlRun(
        `INSERT INTO subagents
          (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
          VALUES (?, ?, ?, 'test', 'running', 'parent-flag', 'test', 1, 1)`,
        agentId,
        sessionId,
        agentId,
      );
      const handle = yield* (yield* WorkTraceStore).startAttempt({
        sessionId,
        parentRunId: "parent-flag",
        parentToolCallId: "call-flag",
        agentId,
        title: "Shadow trace",
        request: "Keep collecting while hidden",
        kind: "start",
        threadId: `subagent-${agentId}`,
      });
      const traces = () =>
        sqlGet("SELECT count(*) AS count FROM work_tasks WHERE origin_session_id = ?", sessionId);

      yield* Effect.acquireRelease(config.update({ workTraceEnabled: false }), () =>
        Effect.orDie(config.update({ workTraceEnabled: true })),
      );
      const hidden = yield* agent.traceTree(sessionId);
      expect(hidden.status).toBe(404);
      expect(yield* json(hidden)).toEqual({ error: "work_trace_disabled" });
      expect(yield* traces()).toEqual({ count: 1 });

      yield* config.update({ workTraceEnabled: true });
      const visible = yield* agent.traceTree(sessionId);
      expect(visible.status).toBe(200);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* json(visible)),
      ).toContain(handle.taskId);
    }),
  );

  it.effect("refuses to run for an unknown session", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      expect((yield* post("no-such-session", "hi")).status).toBe(404);
    }),
  );

  it.effect("stores images with the user turn and sends provider-neutral image parts", () =>
    Effect.gen(function* () {
      yield* selectTestModel("fast-1", "low");
      const sessionId = yield* freshSession;
      const invocations = yield* invocationsOf(sessionId);
      const { attachment, part } = yield* imagePart();
      const tab = yield* openTab(sessionId);

      yield* sdk(() =>
        tab.client.sendMessage({ content: [{ type: "text", content: "look at #1 please" }, part] }),
      );
      yield* until(() => !tab.client.getIsLoading() && tab.answer().length > 0, "the answer");
      expect(tab.answer()).toBe("Saw 1 image(s)");

      const nodes = yield* Nodes;
      const attachments = yield* Attachments;
      const user = (yield* nodes.session(sessionId)).find((node) => node.kind === "user");
      expect(user?.text).toBe("look at #1 please");
      expect((yield* attachments.forNode(user?.id ?? "")).map((stored) => stored.id)).toEqual([
        attachment.id,
      ]);
      expect(
        invocations()[0]?.messages.find((message) => message.role === "user")?.content,
      ).toEqual([{ type: "text", content: "look at #1 please" }, inlineImage]);
      expect(invocations()[0]?.systemPrompts.join("\n")).toContain(attachmentInstructions);

      // A later turn replays the earlier image as inline data the provider can read.
      yield* sdk(() => tab.client.sendMessage("look at it again"));
      yield* until(() => invocations().length === 2, "the second provider invocation");
      expect(
        invocations()[1]?.messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((content) => content.type === "image")
            : [],
        ),
      ).toEqual([inlineImage]);
      expect(invocations()[1]?.systemPrompts.join("\n")).toContain(attachmentInstructions);

      // The stored transcript shows the image again after a reload.
      const session = yield* nodes.session(sessionId);
      const images = yield* Effect.forEach(session, (node) =>
        Effect.map(attachments.forNode(node.id), (found) => ({ nodeId: node.id, found })),
      );
      const [firstUser] = sessionMessages(
        session,
        (nodeId) => images.find((entry) => entry.nodeId === nodeId)?.found ?? [],
      );
      expect(firstUser?.parts).toEqual([{ type: "text", content: "look at #1 please" }, part]);
    }),
  );

  it.effect("a conversation without images gets no image instructions", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const sessionId = yield* freshSession;
      const invocations = yield* invocationsOf(sessionId);
      const response = yield* post(sessionId, "hi");
      yield* sdk(() => response.text());
      expect(invocations()[0]?.systemPrompts.join("\n")).not.toContain(attachmentInstructions);
    }),
  );

  it.effect("refuses images for a text-only model and unknown attachments", () =>
    Effect.gen(function* () {
      yield* selectTestModel("deep-1", "medium");
      const sessionId = yield* freshSession;
      const { part } = yield* imagePart();

      const unsupported = yield* post(sessionId, [{ type: "text", content: "look at this" }, part]);
      expect(unsupported.status).toBe(422);
      expect(yield* json(unsupported)).toMatchObject({ error: "images_not_supported" });

      const unknown = yield* post(sessionId, [
        { type: "image", source: { type: "url", value: attachmentUrl("f".repeat(64)) } },
      ]);
      expect(unknown.status).toBe(400);
    }),
  );
});

/** What AgentChat answers before any run when the account or provider cannot serve one. */
const refusal = Effect.gen(function* () {
  const response = yield* post((yield* TestEnv).session.id, "hi");
  return { status: response.status, body: yield* json(response) };
});

testAgent({ testProvider: { signedIn: false } })("AgentChat.handle signed out", (it) => {
  it.effect("refuses to run without login", () =>
    Effect.gen(function* () {
      expect((yield* refusal).status).toBe(401);
    }),
  );
});

testAgent({ testProvider: {} })("AgentChat.handle without a chosen model", (it) => {
  it.effect("refuses to run without a chosen model", () =>
    Effect.gen(function* () {
      expect(yield* refusal).toEqual({
        status: 412,
        body: { error: "model_selection_required" },
      });
    }),
  );
});

testAgent({ providerRegistry: ProviderRegistry.layer([], []) })(
  "AgentChat.handle without a provider",
  (it) => {
    it.effect("refuses to run when no provider can authenticate", () =>
      Effect.gen(function* () {
        expect(yield* refusal).toEqual({
          status: 503,
          body: { error: "provider_auth_unavailable", provider: "openai" },
        });
      }),
    );
  },
);
