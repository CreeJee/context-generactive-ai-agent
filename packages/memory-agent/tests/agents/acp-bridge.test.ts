import * as acp from "@agentclientprotocol/sdk";
import type { AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";
import { Effect, FileSystem } from "effect";
import { expect } from "vite-plus/test";
import { createAppApi } from "../../src/acp/app-api.ts";
import { startAcpAgent } from "../../src/acp/agent-bridge.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { sessionScopedResponder } from "../support/chat-client.ts";
import { selectTestModel, turnGate } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { appFetch } from "./app-fetch.ts";
import { current, sdk, until } from "./agent-env.ts";

/** Two ends of an in-memory ACP connection. */
const linkedStreams = () => {
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  return {
    agent: { writable: toClient.writable, readable: toAgent.readable },
    client: { writable: toAgent.writable, readable: toClient.readable },
  };
};

/**
 * An editor connected over ACP to the bridge, which serves it from the open agent. The editor
 * answers every permission request with `answerPermission`.
 */
const editor = Effect.fnUntraced(function* (answerPermission: "allow" | "reject" = "allow") {
  yield* current(selectTestModel());
  const fetcher = yield* appFetch;
  const streams = linkedStreams();
  const updates: SessionNotification[] = [];
  const permissions: string[] = [];
  const { agent } = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const bridge = startAcpAgent({
        stream: streams.agent,
        api: createAppApi("http://app.test", (input, init) =>
          new URL(input instanceof Request ? input.url : input).pathname === "/api/auth"
            ? Promise.resolve(Response.json({ status: "signed-in" }))
            : fetcher(input, init),
        ),
      });
      const client = acp
        .client({ name: "test-editor" })
        .onNotification(acp.methods.client.session.update, (ctx) => {
          updates.push(ctx.params);
        })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
          permissions.push(ctx.params.toolCall.title ?? "");
          return { outcome: { outcome: "selected", optionId: answerPermission } };
        })
        .connect(streams.client);
      return { agent: client.agent, close: () => (client.close(), bridge.close()) };
    }),
    ({ close }) => Effect.sync(close),
  );
  yield* sdk(() =>
    agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    }),
  );
  const { project } = yield* TestEnv;
  const text = () =>
    updates
      .flatMap((notification) =>
        notification.update.sessionUpdate === "agent_message_chunk" &&
        notification.update.content.type === "text"
          ? [notification.update.content.text]
          : [],
      )
      .join("");
  return {
    agent,
    updates,
    permissions,
    text,
    newSession: Effect.map(
      sdk(() =>
        agent.request(acp.methods.agent.session.new, { cwd: project.root, mcpServers: [] }),
      ),
      ({ sessionId }) => sessionId,
    ),
    prompt: (sessionId: string, text: string) =>
      sdk(() =>
        agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        }),
      ),
  };
});

// Approval IDs come from tool-call IDs, which are global, so the model scopes them per session.
testAgent({ testProvider: { responder: sessionScopedResponder } })("ACP agent bridge", (it) => {
  it.effect("an editor session is an app session: prompts stream back and are remembered", () =>
    Effect.gen(function* () {
      const { newSession, prompt, text } = yield* editor();
      const sessionId = yield* newSession;
      expect((yield* prompt(sessionId, "hello from zed")).stopReason).toBe("end_turn");
      expect(text()).toBe("Hello from fast-1");
      expect((yield* Nodes).session(sessionId).map((node) => [node.kind, node.text])).toEqual([
        ["user", "hello from zed"],
        ["assistant", "Hello from fast-1"],
      ]);
    }),
  );

  it.effect("a folder that is not a registered project is refused, not registered", () =>
    Effect.gen(function* () {
      const { agent } = yield* editor();
      const fs = yield* FileSystem.FileSystem;
      const elsewhere = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "not-a-project-" }),
      );
      yield* sdk(() =>
        expect(
          agent.request(acp.methods.agent.session.new, { cwd: elsewhere, mcpServers: [] }),
        ).rejects.toThrow(),
      );
    }),
  );

  it.effect("approvals are asked in the editor; tool calls show up as ACP tool calls", () =>
    Effect.gen(function* () {
      const allowed = yield* editor("allow");
      const done = yield* allowed.prompt(yield* allowed.newSession, "shell: printf from-editor");
      expect(done.stopReason).toBe("end_turn");
      expect(allowed.permissions).toEqual(["셸 실행"]);
      expect(allowed.text()).toContain("from-editor");
      const kinds = allowed.updates.map((notification) => notification.update.sessionUpdate);
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_call_update");

      const rejected = yield* editor("reject");
      yield* rejected.prompt(yield* rejected.newSession, "shell: printf never");
      expect(rejected.text()).toContain('"approved":false');
    }),
  );

  it.effect("loading a session replays what was said", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const { agent, newSession, prompt, updates } = yield* editor();
      const sessionId = yield* newSession;
      yield* prompt(sessionId, "remember this line");
      updates.length = 0;
      yield* sdk(() =>
        agent.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: project.root,
          mcpServers: [],
        }),
      );
      const replayed = updates.map((notification) => notification.update.sessionUpdate);
      expect(replayed[0]).toBe("user_message_chunk");
      expect(replayed).toContain("agent_message_chunk");
    }),
  );
});

/** Slow model turns of the cancellation block wait here until it ends. */
const slowTurn = turnGate();

testAgent({ testProvider: { delayedTurnGate: slowTurn.waitFor } })("ACP cancellation", (it) => {
  it.effect(
    "cancel stops the app's run",
    () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(slowTurn.release));
        const { provider } = yield* TestEnv;
        const { agent, newSession } = yield* editor();
        const sessionId = yield* newSession;
        const invocations = () =>
          provider!.adapter.invocations.filter((invocation) => invocation.threadId === sessionId);
        const prompt = agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "slow" }],
        });
        yield* until(() => invocations().length === 1, "ACP invocation");
        yield* sdk(() => agent.notify(acp.methods.agent.session.cancel, { sessionId }));
        expect((yield* sdk(() => prompt)).stopReason).toBe("cancelled");
        expect(invocations()).toHaveLength(1);
      }),
    10_000,
  );
});
