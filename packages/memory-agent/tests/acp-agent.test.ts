import { it } from "@effect/vitest";
import { Cause, Effect, FileSystem } from "effect";
import { withTestPlatform } from "./support/platform.ts";
import { waitUntil } from "./support/wait-until.ts";
import { isTruthy } from "../src/truthy.ts";
import * as acp from "@agentclientprotocol/sdk";
import type { AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect } from "vite-plus/test";
import { createAppApi } from "../src/acp/app-api.ts";
import { startAcpAgent } from "../src/acp/agent-bridge.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { appFetch } from "./support/app-fetch.ts";
import { turnGate, type TestProviderOptions } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";

/** Two ends of an in-memory ACP connection. */
function linkedStreams() {
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  return {
    agent: { writable: toClient.writable, readable: toAgent.readable },
    client: { writable: toAgent.writable, readable: toClient.readable },
  };
}

const acpSetup = Effect.fn("AcpTest.setup")(function* (
  answerPermission: "allow" | "reject" = "allow",
  delayedTurnGate?: TestProviderOptions["delayedTurnGate"],
) {
  const context = yield* sdkCall(() =>
    testRuntime({
      testProvider: isTruthy(delayedTurnGate) ? { delayedTurnGate } : {},
    }),
  );
  yield* sdkCall(() => context.provider!.select(context.runtime));
  const streams = linkedStreams();
  const fetcher = appFetch(context.runtime);
  const agentConnection = startAcpAgent({
    stream: streams.agent,
    api: createAppApi("http://app.test", (input, init) =>
      new URL(input instanceof Request ? input.url : input).pathname === "/api/auth"
        ? Promise.resolve(Response.json({ status: "signed-in" }))
        : fetcher(input, init),
    ),
  });
  const updates: SessionNotification[] = [];
  const permissions: string[] = [];
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
  const text = () =>
    updates
      .flatMap((notification) =>
        notification.update.sessionUpdate === "agent_message_chunk" &&
        notification.update.content.type === "text"
          ? [notification.update.content.text]
          : [],
      )
      .join("");
  const close = () => {
    client.close();
    agentConnection.close();
  };
  yield* Effect.addFinalizer(() => Effect.sync(close));
  yield* sdkCall(() =>
    client.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    }),
  );
  return { ...context, agent: client.agent, updates, permissions, text, close };
});

describe("ACP agent bridge", () => {
  it.live("an editor session is an app session: prompts stream back and are remembered", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const { agent, project, runtime, text } = yield* acpSetup();

        const { sessionId } = yield* sdkCall(() =>
          agent.request(acp.methods.agent.session.new, {
            cwd: project.root,
            mcpServers: [],
          }),
        );
        const done = yield* sdkCall(() =>
          agent.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "hello from zed" }],
          }),
        );
        expect(done.stopReason).toBe("end_turn");
        expect(text()).toBe("Hello from fast-1");
        const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
        expect(nodes.session(sessionId).map((node) => [node.kind, node.text])).toEqual([
          ["user", "hello from zed"],
          ["assistant", "Hello from fast-1"],
        ]);
      }),
    ),
  );

  it.live("a folder that is not a registered project is refused, not registered", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const { agent } = yield* acpSetup();

        const fs = yield* FileSystem.FileSystem;
        const elsewhere = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "not-a-project-" }),
        );
        yield* sdkCall(() =>
          expect(
            agent.request(acp.methods.agent.session.new, { cwd: elsewhere, mcpServers: [] }),
          ).rejects.toThrow(),
        );
      }),
    ),
  );

  it.live("approvals are asked in the editor; tool calls show up as ACP tool calls", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const allowed = yield* acpSetup("allow");

        const { sessionId } = yield* sdkCall(() =>
          allowed.agent.request(acp.methods.agent.session.new, {
            cwd: allowed.project.root,
            mcpServers: [],
          }),
        );
        const done = yield* sdkCall(() =>
          allowed.agent.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "shell: printf from-editor" }],
          }),
        );
        expect(done.stopReason).toBe("end_turn");
        expect(allowed.permissions).toEqual(["셸 실행"]);
        expect(allowed.text()).toContain("from-editor");
        const kinds = allowed.updates.map((notification) => notification.update.sessionUpdate);
        expect(kinds).toContain("tool_call");
        expect(kinds).toContain("tool_call_update");

        const rejected = yield* acpSetup("reject");

        const { sessionId: rejectedSessionId } = yield* sdkCall(() =>
          rejected.agent.request(acp.methods.agent.session.new, {
            cwd: rejected.project.root,
            mcpServers: [],
          }),
        );
        yield* sdkCall(() =>
          rejected.agent.request(acp.methods.agent.session.prompt, {
            sessionId: rejectedSessionId,
            prompt: [{ type: "text", text: "shell: printf never" }],
          }),
        );
        expect(rejected.text()).toContain('"approved":false');
      }),
    ),
  );

  it.live(
    "cancel stops the app's run",
    () =>
      withTestPlatform(
        Effect.gen(function* () {
          const gate = turnGate();
          yield* Effect.addFinalizer(() => Effect.sync(gate.release));
          const { agent, project, provider } = yield* acpSetup("allow", gate.waitFor);

          const { sessionId } = yield* sdkCall(() =>
            agent.request(acp.methods.agent.session.new, {
              cwd: project.root,
              mcpServers: [],
            }),
          );
          const prompt = agent.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "slow" }],
          });
          yield* waitUntil(
            () => provider!.adapter.invocations.length === 1,
            "ACP invocation",
            1_000,
          );
          yield* sdkCall(() => agent.notify(acp.methods.agent.session.cancel, { sessionId }));
          expect((yield* sdkCall(() => prompt)).stopReason).toBe("cancelled");
          expect(provider!.adapter.invocations).toHaveLength(1);
        }),
      ),
    10_000,
  );

  it.live("loading a session replays what was said", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const second = yield* acpSetup();

        const { sessionId } = yield* sdkCall(() =>
          second.agent.request(acp.methods.agent.session.new, {
            cwd: second.project.root,
            mcpServers: [],
          }),
        );
        yield* sdkCall(() =>
          second.agent.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "remember this line" }],
          }),
        );
        second.updates.length = 0;
        yield* sdkCall(() =>
          second.agent.request(acp.methods.agent.session.load, {
            sessionId,
            cwd: second.project.root,
            mcpServers: [],
          }),
        );
        const replayed = second.updates.map((notification) => notification.update.sessionUpdate);
        expect(replayed[0]).toBe("user_message_chunk");
        expect(replayed).toContain("agent_message_chunk");
      }),
    ),
  );
});

const sdkCall = Effect.fn("AcpTest.sdkCall")(<A>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
