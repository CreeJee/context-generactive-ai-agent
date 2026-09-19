import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vite-plus/test";
import { AppApi } from "../src/acp/app-api.ts";
import { startAcpAgent } from "../src/acp/agent-bridge.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { appFetch } from "./support/app-fetch.ts";
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

async function acpSetup(answerPermission: "allow" | "reject" = "allow") {
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  const streams = linkedStreams();
  const fetcher = appFetch(context.runtime);
  const agentConnection = startAcpAgent({
    stream: streams.agent,
    api: new AppApi("http://app.test", (input, init) =>
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
  await client.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  return { ...context, agent: client.agent, updates, permissions, text, close };
}

describe("ACP agent bridge", () => {
  test("an editor session is an app session: prompts stream back and are remembered", async () => {
    const { agent, project, runtime, text, close } = await acpSetup();
    try {
      const { sessionId } = await agent.request(acp.methods.agent.session.new, {
        cwd: project.root,
        mcpServers: [],
      });
      const done = await agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "hello from zed" }],
      });
      expect(done.stopReason).toBe("end_turn");
      expect(text()).toBe("Hello from fast-1");
      const nodes = await runtime.runPromise(Nodes);
      expect(nodes.session(sessionId).map((node) => [node.kind, node.text])).toEqual([
        ["user", "hello from zed"],
        ["assistant", "Hello from fast-1"],
      ]);
    } finally {
      close();
    }
  });

  test("a folder that is not a registered project is refused, not registered", async () => {
    const { agent, close } = await acpSetup();
    try {
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "not-a-project-")));
      await expect(
        agent.request(acp.methods.agent.session.new, { cwd: elsewhere, mcpServers: [] }),
      ).rejects.toThrow();
    } finally {
      close();
    }
  });

  test("approvals are asked in the editor; tool calls show up as ACP tool calls", async () => {
    const allowed = await acpSetup("allow");
    try {
      const { sessionId } = await allowed.agent.request(acp.methods.agent.session.new, {
        cwd: allowed.project.root,
        mcpServers: [],
      });
      const done = await allowed.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "shell: printf from-editor" }],
      });
      expect(done.stopReason).toBe("end_turn");
      expect(allowed.permissions).toEqual(["셸 실행"]);
      expect(allowed.text()).toContain("from-editor");
      const kinds = allowed.updates.map((notification) => notification.update.sessionUpdate);
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_call_update");
    } finally {
      allowed.close();
    }

    const rejected = await acpSetup("reject");
    try {
      const { sessionId } = await rejected.agent.request(acp.methods.agent.session.new, {
        cwd: rejected.project.root,
        mcpServers: [],
      });
      await rejected.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "shell: printf never" }],
      });
      expect(rejected.text()).toContain('"approved":false');
    } finally {
      rejected.close();
    }
  });

  test("cancel stops the app's run; loading a session replays it", async () => {
    const { agent, project, close, updates } = await acpSetup();
    try {
      const { sessionId } = await agent.request(acp.methods.agent.session.new, {
        cwd: project.root,
        mcpServers: [],
      });
      const prompt = agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "slow" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await agent.notify(acp.methods.agent.session.cancel, { sessionId });
      expect((await prompt).stopReason).toBe("cancelled");
    } finally {
      close();
    }

    // A second editor connection loads the same session and sees what was said.
    const second = await acpSetup();
    try {
      updates.length = 0;
      const { sessionId } = await second.agent.request(acp.methods.agent.session.new, {
        cwd: second.project.root,
        mcpServers: [],
      });
      await second.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "remember this line" }],
      });
      second.updates.length = 0;
      await second.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: second.project.root,
        mcpServers: [],
      });
      const replayed = second.updates.map((notification) => notification.update.sessionUpdate);
      expect(replayed[0]).toBe("user_message_chunk");
      expect(replayed).toContain("agent_message_chunk");
    } finally {
      second.close();
    }
  });
});
