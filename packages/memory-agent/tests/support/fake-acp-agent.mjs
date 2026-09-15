// A small external ACP agent for tests. Each start is appended to $FAKE_ACP_LOG. While
// $FAKE_ACP_REFUSE names an existing file, it exits at once, so connection attempts fail.
import { appendFileSync, existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

if (process.env.FAKE_ACP_REFUSE && existsSync(process.env.FAKE_ACP_REFUSE)) process.exit(2);
if (process.env.FAKE_ACP_LOG)
  appendFileSync(
    process.env.FAKE_ACP_LOG,
    `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), secret: process.env.SHOULD_NOT_LEAK ?? null })}\n`,
  );

const history = new Map();
const cancelled = new Set();
let nextSession = 1;

const say = (client, sessionId, text) =>
  client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

acp
  .agent({ name: "fake-external" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "fake-external", version: "1.0.0" },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `ext-${nextSession++}`;
    history.set(sessionId, []);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params;
    const text = ctx.params.prompt
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    const earlier = history.get(sessionId) ?? [];
    earlier.push(text);

    if (text.includes("crash")) {
      await say(ctx.client, sessionId, "partial before crash");
      setTimeout(() => process.exit(1), 20);
      return new Promise(() => undefined);
    }
    if (text.includes("needs permission")) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Edit README.md",
          kind: "edit",
          status: "pending",
        },
      });
      const answer = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId: "t1",
          title: "Edit README.md",
          kind: "edit",
          rawInput: { path: "README.md" },
        },
        options: [
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "once", name: "Once", kind: "allow_once" },
          { optionId: "no", name: "No", kind: "reject_once" },
        ],
      });
      const chosen = answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: chosen === "once" ? "completed" : "failed",
        },
      });
      await say(ctx.client, sessionId, `permission: ${chosen}`);
      return { stopReason: "end_turn" };
    }
    if (text.includes("slow")) {
      for (let step = 0; step < 50; step++) {
        if (cancelled.delete(sessionId)) return { stopReason: "cancelled" };
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    await say(ctx.client, sessionId, `external: ${text} (turn ${earlier.length})`);
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    cancelled.add(ctx.params.sessionId);
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
