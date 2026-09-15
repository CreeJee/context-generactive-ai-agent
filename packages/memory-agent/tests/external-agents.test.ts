import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { RelayedApprovals } from "../src/approvals/relayed.ts";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { ExternalAgents } from "../src/external-agents/agents.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { approvalToolDefinitions, permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const fakeAgent = fileURLToPath(new URL("./support/fake-acp-agent.mjs", import.meta.url));
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

async function agentSetup() {
  const context = await testRuntime({ codex: fakeCodex });
  const log = join(context.base, "acp-starts.log");
  const refuse = join(context.base, "refuse");
  mkdirSync(join(context.project.root, ".agents"), { recursive: true });
  writeFileSync(
    join(context.project.root, ".agents", "agents.json"),
    JSON.stringify({
      agents: {
        fake: {
          command: process.execPath,
          args: [fakeAgent],
          env: { FAKE_ACP_LOG: log, FAKE_ACP_REFUSE: refuse },
        },
      },
    }),
  );
  const agents = await context.runtime.runPromise(ExternalAgents);
  const run = <A>(effect: Effect.Effect<A>) => context.runtime.runPromise(effect);
  const starts = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const linkOf = async () => {
    const view = (await run(agents.overview(context.project))).agents[0]!;
    return view.state.status === "trusted" ? view.state.link : null;
  };
  const prompt = (text: string, options: { signal?: AbortSignal; approve?: boolean } = {}) =>
    agents.prompt(context.project, "fake", context.session.id, text, {
      signal: options.signal ?? new AbortController().signal,
      askPermission: async () => options.approve ?? false,
    });
  return { ...context, agents, run, starts, refuse, linkOf, prompt, log };
}

describe("external ACP agents", () => {
  test("an agent starts only once trusted, in the project, without the app's environment", async () => {
    const { agents, run, project, starts, prompt } = await agentSetup();
    process.env.SHOULD_NOT_LEAK = "app-secret";
    try {
      expect(await prompt("hi")).toEqual({ status: "unavailable", reason: "not_trusted" });
      expect(starts()).toEqual([]);

      const trusted = await run(agents.setTrusted(project, "project", "fake", true));
      expect(trusted.agents[0]).toMatchObject({
        name: "fake",
        envNames: ["FAKE_ACP_LOG", "FAKE_ACP_REFUSE"],
        state: { status: "trusted", link: { status: "idle" } },
      });
      expect(starts()).toEqual([]);

      expect(await prompt("hi")).toMatchObject({
        status: "completed",
        answer: "external: hi (turn 1)",
      });
      // The same conversation continues the agent's session.
      expect(await prompt("again")).toMatchObject({ answer: "external: again (turn 2)" });
      expect(starts()).toEqual([expect.objectContaining({ cwd: project.root, secret: null })]);
    } finally {
      delete process.env.SHOULD_NOT_LEAK;
    }
  });

  test("the agent's permission requests go to the user and are answered once, never always", async () => {
    const { agents, run, project, prompt } = await agentSetup();
    await run(agents.setTrusted(project, "project", "fake", true));

    expect(await prompt("needs permission", { approve: true })).toMatchObject({
      answer: "permission: once",
      toolCalls: [{ title: "Edit README.md", status: "completed" }],
    });
    expect(await prompt("needs permission", { approve: false })).toMatchObject({
      answer: "permission: no",
    });
  });

  test("cancelling sends session/cancel", async () => {
    const { agents, run, project, prompt, log } = await agentSetup();
    await run(agents.setTrusted(project, "project", "fake", true));
    const controller = new AbortController();
    const pending = prompt("slow", { signal: controller.signal });
    await until(() => existsSync(`${log}.slow`), "the slow prompt to reach the agent");
    controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
  });

  test("a dropped connection reconnects on its own, stops after two failures in a row, and never resends", async () => {
    const { agents, run, project, prompt, starts, refuse, linkOf } = await agentSetup();
    await run(agents.setTrusted(project, "project", "fake", true));

    expect(await prompt("crash now")).toEqual({
      status: "disconnected",
      answer: "partial before crash",
      toolCalls: [],
    });
    await until(() => starts().length === 2, "the automatic reconnect");
    let link = await linkOf();
    for (let attempt = 0; attempt < 100 && link?.status !== "connected"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      link = await linkOf();
    }
    expect(link).toMatchObject({ status: "connected" });
    // The crashed prompt was not sent again: the new process has seen no prompt.
    expect(await prompt("after reconnect")).toMatchObject({
      answer: "external: after reconnect (turn 1)",
    });

    writeFileSync(refuse, "");
    await prompt("crash again");
    link = await linkOf();
    for (let attempt = 0; attempt < 100 && link?.status !== "stopped"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      link = await linkOf();
    }
    expect(link).toMatchObject({ status: "stopped", failures: 2 });
    expect(await prompt("while stopped")).toEqual({
      status: "unavailable",
      reason: "stopped_after_failures",
    });

    rmSync(refuse);
    const reconnected = await run(agents.reconnect(project, "fake"));
    expect(reconnected.agents[0]?.state).toMatchObject({
      status: "trusted",
      link: { status: "connected" },
    });
    expect(await prompt("back")).toMatchObject({ status: "completed" });
  });

  test("delegation from a chat needs approval, and the agent's own request is relayed to the page", async () => {
    const context = await agentSetup();
    const { runtime, project, session, agents, run } = context;
    await run(agents.setTrusted(project, "project", "fake", true));
    await runtime.runPromise(Effect.flatMap(CodexModels, (models) => models.select("fast-1")));
    const relayed = await runtime.runPromise(RelayedApprovals);
    const client = new ChatClient({
      tools: approvalToolDefinitions,
      interrupts: [permissionReviewInterrupt],
      connection: fetchServerSentEvents("http://127.0.0.1/api/chat", {
        fetchClient: (input, init) =>
          runtime.runPromise(
            Effect.flatMap(AgentChat, (agent) =>
              agent.handle(new Request(input, init), session.id),
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

    await client.sendMessage(
      'call delegate_to_agent {"agent":"fake","task":"needs permission to edit"}',
    );
    await until(() => client.getInterrupts().length === 1, "approval of the delegation");
    expect(client.getInterrupts()[0]).toMatchObject({
      payload: { toolName: "delegate_to_agent", askedBy: "every_call" },
    });
    client.resolveInterrupts((item) => {
      if (item.kind === "generic") item.resolveInterrupt({ approved: true });
    });
    await until(() => relayed.pending(session.id).length === 1, "the agent's permission request");
    const [request] = relayed.pending(session.id);
    expect(request).toMatchObject({
      requester: { kind: "external_agent", agent: "fake" },
      toolName: "Edit README.md",
      askedBy: "agent",
    });
    relayed.answer(session.id, request!.id, true);
    await until(() => answer().includes("permission: once"), "the delegation result");
  });

  test("a direct conversation with an external agent gets matching memory and is remembered", async () => {
    const { runtime, project, session: earlier, agents, run } = await agentSetup();
    const { direct, untrusted } = await runtime.runPromise(
      Effect.gen(function* () {
        (yield* Nodes).append({
          projectId: project.id,
          sessionId: earlier.id,
          kind: "user",
          text: "로그 포맷은 logfmt로 하기로 했다.",
        });
        yield* (yield* Indexer).indexAll();
        const sessions = yield* Sessions;
        return {
          direct: yield* sessions.create(project.id, null, "fake"),
          untrusted: yield* sessions.create(project.id, null, "fake"),
        };
      }),
    );
    const send = (sessionId: string, text: string) =>
      runtime.runPromise(
        Effect.flatMap(AgentChat, (agent) =>
          agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                threadId: sessionId,
                runId: `run-${Math.random().toString(36).slice(2)}`,
                messages: [{ id: "m1", role: "user", content: text }],
                tools: [],
                context: [],
              }),
            }),
            sessionId,
          ),
        ),
      );

    // Not trusted yet: the conversation cannot start the agent.
    expect((await send(untrusted.id, "hello")).status).toBe(409);

    await run(agents.setTrusted(project, "project", "fake", true));
    const response = await send(direct.id, "로그 포맷 뭐였지?");
    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain("Memory from context-generactive-agent");
    expect(events).toContain("logfmt");

    const nodes = await runtime.runPromise(Nodes);
    const recorded = nodes.session(direct.id);
    expect(recorded.map((node) => node.kind)).toEqual(["user", "assistant"]);
    expect(recorded[0]?.text).toBe("로그 포맷 뭐였지?");
    expect(recorded[1]?.detail).toMatchObject({ externalAgent: "fake" });
  });
});
