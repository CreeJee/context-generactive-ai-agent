import { fileURLToPath } from "node:url";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const fakeCodex = CodexAppServer.withCommand({
  executable: process.execPath,
  args: [fakeServer, "--signed-in"],
});

const Log = Schema.Struct({ log: Schema.Array(Schema.Struct({ method: Schema.String })) });

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A real TanStack chat client talking to AgentChat in-process, like the browser UI does. */
async function approvalSetup() {
  const context = await testRuntime({ codex: fakeCodex });
  await context.runtime.runPromise(
    Effect.flatMap(CodexModels, (models) => models.select("fast-1")),
  );
  const client = new ChatClient({
    tools: approvalToolDefinitions,
    connection: fetchServerSentEvents("http://127.0.0.1/api/chat", {
      fetchClient: (input, init) =>
        context.runtime.runPromise(
          Effect.flatMap(AgentChat, (agent) =>
            agent.handle(new Request(input, init), context.session.id),
          ),
        ),
    }),
  });
  const lastText = () =>
    client
      .getMessages()
      .flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
          : [],
      )
      .join("");
  return { ...context, client, lastText };
}

describe("approval-gated tools", () => {
  test("run_shell waits for approval, then runs and the same codex turn continues", async () => {
    const { client, runtime, session, lastText } = await approvalSetup();

    await client.sendMessage("please use the shell");
    await until(() => client.getInterrupts().length === 1, "the approval request");
    expect(client.getInterrupts()[0]).toMatchObject({
      kind: "tool-approval",
      toolName: "run_shell",
      originalArgs: { command: "printf approved-output", reason: "check the shell" },
    });
    // Nothing has run yet: the call is recorded, its result is not.
    const nodes = await runtime.runPromise(Nodes);
    expect(nodes.session(session.id).map((node) => node.kind)).toEqual([
      "user",
      "assistant",
      "tool_call",
    ]);

    client.resolveInterrupts(true);
    await until(() => lastText().startsWith("Shell said"), "the answer after approval");
    await until(() => !client.getIsLoading(), "the run to finish");
    expect(lastText()).toContain("approved-output");
    expect(nodes.session(session.id).map((node) => node.kind)).toEqual([
      "user",
      "assistant",
      "tool_call",
      "tool_result",
      "assistant",
    ]);
    const [, , call, result] = nodes.session(session.id);
    expect(result!.runId).toBe(call!.runId);
    expect(result!.detail).toMatchObject({ toolName: "run_shell", ok: true });

    // The approval did not restart the conversation in codex.
    const codex = await runtime.runPromise(CodexAppServer);
    const { log } = await runtime.runPromise(codex.request("test/log", {}, Log));
    expect(log.filter((entry) => entry.method === "thread/start")).toHaveLength(1);
  });

  test("Verify can run an approval-gated shell check", async () => {
    const { client, runtime, session, lastText } = await approvalSetup();
    await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, {
          statement: "Verify the implementation",
          outcomes: ["Checks pass"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        });
        yield* workflows.updatePlan(session.id, {
          summary: "Implement and verify",
          steps: [
            {
              id: "implementation",
              title: "Implement",
              description: "Make the change",
              dependsOn: [],
              acceptanceCriteria: ["The check passes"],
              ruleRefs: [],
            },
          ],
          risks: [],
          openQuestions: [],
          status: "ready",
        });
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [{ id: "implementation", status: "completed", evidence: ["change made"] }],
          goalEvidence: [],
          planEvidence: [],
          detail: "Implementation complete",
        });
        yield* workflows.finishRun(session.id, "execute");
      }),
    );

    await client.sendMessage("please use the shell");
    await until(() => client.getInterrupts().length === 1, "the Verify approval request");
    expect(client.getInterrupts()[0]).toMatchObject({ toolName: "run_shell" });
    client.resolveInterrupts(true);
    await until(() => lastText().includes("approved-output"), "the Verify shell result");
    await until(() => !client.getIsLoading(), "the Verify run to finish");
    expect(lastText()).toContain("approved-output");
  });

  test("a reloaded page gets the pending approval back from the server and can answer it", async () => {
    const context = await approvalSetup();
    const { runtime, session } = context;
    await context.client.sendMessage("please use the shell");
    await until(() => context.client.getInterrupts().length === 1, "the approval request");
    // The tab closes; nothing of the first client survives.
    context.client.dispose();

    const connection = fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${session.id}`, {
      fetchClient: (input, init) =>
        runtime.runPromise(
          Effect.flatMap(AgentChat, (agent) =>
            (init?.method ?? "GET") === "POST"
              ? agent.handle(new Request(input, init), session.id)
              : agent.hydrate(new Request(input, init), session.id),
          ),
        ),
    });
    const reloaded = new ChatClient({
      threadId: session.id,
      persistence: true,
      tools: approvalToolDefinitions,
      connection,
    });
    reloaded.attach();
    await until(() => reloaded.getInterrupts().length === 1, "the restored approval");
    expect(reloaded.getMessages().map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(reloaded.getInterrupts()[0]).toMatchObject({
      kind: "tool-approval",
      toolName: "run_shell",
    });

    reloaded.resolveInterrupts(true);
    const text = () =>
      reloaded
        .getMessages()
        .flatMap((message) =>
          message.role === "assistant"
            ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
            : [],
        )
        .join("");
    await until(() => text().startsWith("Shell said"), "the answer after the reload");
    await until(() => !reloaded.getIsLoading(), "the run to finish");
    expect(text()).toContain("approved-output");
    reloaded.dispose();
  });

  test("a server restart retires an approval whose continuation no longer exists", async () => {
    const context = await approvalSetup();
    const { session } = context;
    await context.client.sendMessage("please use the shell");
    await until(() => context.client.getInterrupts().length === 1, "the approval request");
    context.client.dispose();

    const runtime = await context.reopen();
    const connection = fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${session.id}`, {
      fetchClient: (input, init) =>
        runtime.runPromise(
          Effect.flatMap(AgentChat, (agent) => agent.hydrate(new Request(input, init), session.id)),
        ),
    });
    const restarted = new ChatClient({
      threadId: session.id,
      persistence: true,
      tools: approvalToolDefinitions,
      connection,
    });
    restarted.attach();
    await until(() => restarted.getMessages().length > 0, "the restored transcript");

    expect(restarted.getInterrupts()).toEqual([]);
    expect(restarted.getError()).toBeUndefined();
    const response = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.status(session.id, null)),
    );
    expect(await response.json()).toMatchObject({
      running: null,
      lastRun: { status: "failed", error: { code: "server_restarted" } },
    });
    restarted.dispose();
  });

  test("a broken approval continuation can be discarded without running the tool", async () => {
    const context = await approvalSetup();
    const { runtime, session } = context;
    await context.client.sendMessage("please use the shell");
    await until(() => context.client.getInterrupts().length === 1, "the approval request");
    context.client.dispose();

    const response = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.discardInterrupts(session.id, null)),
    );
    expect(await response.json()).toEqual({ discarded: 1 });
    const state = await runtime.runPromise(ChatState);
    expect(await state.persistence.stores.interrupts.listPending(session.id)).toEqual([]);

    const status = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.status(session.id, null)),
    );
    expect(await status.json()).toMatchObject({
      running: null,
      lastRun: { status: "failed", error: { code: "interrupt_continuation_lost" } },
    });
    const nodes = await runtime.runPromise(Nodes);
    expect(nodes.session(session.id).filter((node) => node.kind === "tool_result")).toEqual([]);
  });

  test("a declined approval never runs the command and tells the model", async () => {
    const { client, runtime, session, lastText } = await approvalSetup();

    await client.sendMessage("please use the shell");
    await until(() => client.getInterrupts().length === 1, "the approval request");
    client.resolveInterrupts(false);
    await until(() => lastText().startsWith("Shell said"), "the answer after declining");
    await until(() => !client.getIsLoading(), "the run to finish");
    expect(lastText()).toContain('"approved":false');
    expect(lastText()).not.toContain("approved-output");

    const nodes = await runtime.runPromise(Nodes);
    const result = nodes.session(session.id).find((node) => node.kind === "tool_result");
    expect(result?.detail).toMatchObject({ toolName: "run_shell", ok: false });
  });
});
