import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat, workspaceInstructions } from "../src/agent/chat.ts";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Projects } from "../src/projects/projects.ts";
import { approvalToolDefinitions, permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const fakeCodex = CodexAppServer.withCommand({
  executable: process.execPath,
  args: [fakeServer, "--signed-in"],
});

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A project in `auto` mode and a real chat client talking to AgentChat in-process. */
async function autoSetup() {
  const context = await testRuntime({ codex: fakeCodex });
  await context.runtime.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodexModels).select("fast-1");
      yield* (yield* Projects).setPermissionMode(context.project.id, "auto");
    }),
  );
  const client = new ChatClient({
    tools: approvalToolDefinitions,
    interrupts: [permissionReviewInterrupt],
    connection: fetchServerSentEvents("http://127.0.0.1/api/chat", {
      fetchClient: (input, init) =>
        context.runtime.runPromise(
          Effect.flatMap(AgentChat, (agent) =>
            agent.handle(new Request(input, init), context.session.id),
          ),
        ),
    }),
  });
  const answer = () =>
    client
      .getMessages()
      .flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
          : [],
      )
      .join("");
  const finished = async () => {
    await until(() => answer().startsWith("Shell said"), "the answer");
    await until(() => !client.getIsLoading(), "the run to finish");
  };
  const [reviews, nodes] = await Promise.all([
    context.runtime.runPromise(PermissionReviews),
    context.runtime.runPromise(Nodes),
  ]);
  const shellResult = () =>
    nodes.session(context.session.id).find((node) => node.kind === "tool_result");
  return { ...context, client, answer, finished, reviews, shellResult };
}

describe("workspace instructions", () => {
  test("say what the permission mode allows, with the date and shell codex no longer describes", async () => {
    const { project, storage, home } = await testRuntime({ codex: fakeCodex });
    const places = { storageRoot: storage, globalSkills: join(home, ".agents", "skills") };
    const auto = workspaceInstructions(
      { ...project, permissionMode: "auto" },
      places,
      new Date("2026-09-15T12:00:00Z"),
    );
    expect(auto).toContain("reviewed before each call: routine requested work runs");
    expect(auto).toMatch(/Today is 2026-09-1[56] \(.+\)\. run_shell runs commands with \S+ on /);
    expect(auto).not.toContain("read-only");
    expect(workspaceInstructions({ ...project, permissionMode: "ask" }, places)).toContain(
      "wait for the user's approval of each call",
    );
    // Where the app keeps its own settings, and that its storage is not for the file tools.
    expect(auto).toContain(
      `MCP servers: ${join(storage, "mcp.json")}, ${join(project.root, ".mcp.json")}`,
    );
    expect(auto).toContain(
      `${join(storage, "agents.json")}, ${join(project.root, ".agents", "agents.json")}`,
    );
    expect(auto).toContain("the file tools never open it");
  });
});

describe("auto permission mode", () => {
  test("runs a call the review allows without asking, and records why", async () => {
    const { client, answer, finished, reviews, session, shellResult } = await autoSetup();

    await client.sendMessage("shell: printf reviewed-ok");
    await finished();
    expect(client.getInterrupts()).toHaveLength(0);
    expect(answer()).toContain("reviewed-ok");
    expect(reviews.latest(session.id, "call-shell")).toMatchObject({
      decision: "allow",
      decidedBy: "classifier",
      reason: "검토 결과: allow",
    });
    expect(shellResult()?.detail).toMatchObject({
      ok: true,
      permission: { decision: "allow", decidedBy: "classifier" },
    });
  });

  test("never runs a blocked call and tells the model why", async () => {
    const { client, answer, finished, shellResult } = await autoSetup();

    await client.sendMessage("shell: printf block-me-output");
    await finished();
    expect(client.getInterrupts()).toHaveLength(0);
    expect(answer()).toContain("blocked_by_permission_review");
    expect(answer()).not.toContain("block-me-output\\n");
    expect(shellResult()?.detail).toMatchObject({
      ok: false,
      permission: { decision: "block" },
    });
  });

  test("asks the user when the review is unsure, then runs only after approval", async () => {
    const { client, answer, finished, reviews, session, shellResult } = await autoSetup();

    await client.sendMessage("shell: printf ask-me-approved");
    await until(() => client.getInterrupts().length === 1, "the permission review");
    const [interrupt] = client.getInterrupts();
    expect(interrupt).toMatchObject({
      kind: "generic",
      definitionId: "permission-review",
      payload: { toolName: "run_shell", reason: "검토 결과: ask" },
    });
    expect(shellResult()).toBeUndefined();

    client.resolveInterrupts((item) => {
      if (item.kind === "generic" && item.binding.definitionId === permissionReviewInterrupt.id)
        item.resolveInterrupt({ approved: true });
    });
    await finished();
    expect(answer()).toContain("ask-me-approved");
    expect(reviews.latest(session.id, "call-shell")).toMatchObject({
      decision: "approved",
      decidedBy: "user",
    });
    expect(shellResult()?.detail).toMatchObject({ ok: true, permission: { decision: "approved" } });
  });

  test("a declined review or a broken verdict never runs the call", async () => {
    const declined = await autoSetup();
    await declined.client.sendMessage("shell: printf ask-me-declined");
    await until(() => declined.client.getInterrupts().length === 1, "the permission review");
    declined.client.resolveInterrupts((item) => {
      if (item.kind === "generic") item.resolveInterrupt({ approved: false });
    });
    await declined.finished();
    expect(declined.answer()).toContain('"approved":false');
    expect(declined.shellResult()?.detail).toMatchObject({
      ok: false,
      permission: { decision: "denied", decidedBy: "user" },
    });

    const broken = await autoSetup();
    await broken.client.sendMessage("shell: printf broken-review");
    await until(() => broken.client.getInterrupts().length === 1, "the fallback question");
    expect(broken.reviews.latest(broken.session.id, "call-shell")).toMatchObject({
      decision: "ask",
      decidedBy: "fallback",
    });
  });
});

test("a restored permission review resolves once after leaving the conversation", async () => {
  const { client, runtime, session, shellResult } = await autoSetup();
  await client.sendMessage("shell: printf ask-me-restored");
  await until(() => client.getInterrupts().length === 1, "pending review");
  client.dispose();
  const reloaded = new ChatClient({
    threadId: session.id,
    persistence: true,
    tools: approvalToolDefinitions,
    interrupts: [permissionReviewInterrupt],
    connection: fetchServerSentEvents("http://127.0.0.1/api/chat", {
      fetchClient: (input, init) =>
        runtime.runPromise(
          Effect.flatMap(AgentChat, (agent) =>
            (init?.method ?? "GET") === "POST"
              ? agent.handle(new Request(input, init), session.id)
              : agent.hydrate(new Request(input, init), session.id),
          ),
        ),
    }),
  });
  reloaded.attach();
  try {
    await until(() => reloaded.getInterrupts().length === 1, "restored review");
    reloaded.resolveInterrupts((item) => {
      if (item.kind === "generic") item.resolveInterrupt({ approved: true });
    });
    await until(() => shellResult() !== undefined, "approved call to execute");
    await until(() => !reloaded.getIsLoading(), "resumed run to finish");
    expect(reloaded.getInterrupts()).toHaveLength(0);
    expect(shellResult()?.detail).toMatchObject({ ok: true });
  } finally {
    reloaded.dispose();
  }
});
