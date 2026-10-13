// Native ACP processes prove actual OS environment isolation, reconnect and cancellation.
import { fileURLToPath } from "node:url";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Effect, Fiber, FiberSet, FileSystem, Path, Schedule, Schema } from "effect";
import { expect, vi } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { GlobalConfig } from "../../src/config/global-config.ts";
import { RelayedApprovals } from "../../src/approvals/relayed.ts";
import { ExternalAgents } from "../../src/external-agents/agents.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { BackgroundTasks } from "../../src/tools/background.ts";
import { DelegateTools } from "../../src/tools/delegate.ts";
import { approvalToolDefinitions, permissionReviewInterrupt } from "../../src/tools/definitions.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { current, encodeJson, freshProject, post, sdk, until } from "./agent-env.ts";

const fakeAgent = fileURLToPath(new URL("../support/fake-acp-agent.ts", import.meta.url));

const Start = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int, cwd: Schema.String, secret: Schema.NullOr(Schema.String) }),
);

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Wait for an observation that itself needs an Effect, such as reading the start log. */
const eventually = <E, R>(condition: Effect.Effect<boolean, E, R>, what: string) =>
  condition.pipe(
    Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(20) }),
    Effect.timeout(6000),
    Effect.annotateLogs("waitingFor", what),
  );

/**
 * A project of the test's own configuring the fake ACP agent, which logs every start and every
 * slow prompt next to it, and refuses to start while the `refuse` file exists.
 */
const fakeAgentProject = Effect.fnUntraced(function* () {
  const { base } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { project, sessionId } = yield* freshProject();
  const logs = yield* fs.makeTempDirectory({ directory: base, prefix: "acp-" });
  const log = path.join(logs, "starts.log");
  const refuse = path.join(logs, "refuse");
  const config = path.join(project.root, ".agents", "agents.json");
  yield* fs.makeDirectory(path.dirname(config), { recursive: true });
  yield* fs.writeFileString(
    config,
    yield* encodeJson({
      agents: {
        fake: {
          command: process.execPath,
          args: [fakeAgent],
          env: { FAKE_ACP_LOG: log, FAKE_ACP_REFUSE: refuse },
        },
      },
    }),
  );
  const agents = yield* ExternalAgents;
  const starts = Effect.gen(function* () {
    if (!(yield* fs.exists(log))) return [];
    const lines = (yield* fs.readFileString(log)).trim().split("\n");
    return yield* Effect.forEach(lines, (line) => Schema.decodeEffect(Start)(line));
  });
  const link = Effect.map(agents.overview(project), ({ agents: [view] }) => {
    switch (view?.state.status) {
      case "trusted":
        return view.state.link;
      default:
        return null;
    }
  });
  const prompt = (text: string, options: { signal?: AbortSignal; approve?: boolean } = {}) =>
    Effect.tryPromise({
      try: (signal) =>
        agents.prompt(project, "fake", sessionId, text, {
          signal: options.signal ?? signal,
          askPermission: () => Promise.resolve(options.approve ?? false),
        }),
      catch: (cause) => new Cause.UnknownError(cause),
    });
  const trust = agents.setTrusted(project, "project", "fake", true);
  return { project, sessionId, agents, config, log, refuse, starts, link, prompt, trust };
});

testAgent({ testProvider: {} })("external ACP agents", (it) => {
  it.effect(
    "an agent starts only once trusted, in the project, without the app's environment",
    () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("SHOULD_NOT_LEAK", "app-secret")),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );
        const { project, starts, prompt, trust } = yield* fakeAgentProject();
        expect(yield* prompt("hi")).toEqual({ status: "unavailable", reason: "not_trusted" });
        expect(yield* starts).toEqual([]);

        const trusted = yield* trust;
        expect(trusted.agents[0]).toMatchObject({
          name: "fake",
          envNames: ["FAKE_ACP_LOG", "FAKE_ACP_REFUSE"],
          state: { status: "trusted", link: { status: "idle" } },
        });
        expect(yield* starts).toEqual([]);

        expect(yield* prompt("hi")).toMatchObject({
          status: "completed",
          answer: "external: hi (turn 1)",
        });
        // The same conversation continues the agent's session.
        expect(yield* prompt("again")).toMatchObject({ answer: "external: again (turn 2)" });
        expect(yield* starts).toEqual([
          expect.objectContaining({ cwd: project.root, secret: null }),
        ]);
      }),
  );

  it.effect("removing a configured agent closes its live process", () =>
    Effect.gen(function* () {
      const { project, agents, config, starts, prompt, trust } = yield* fakeAgentProject();
      yield* trust;
      expect(yield* prompt("hi")).toMatchObject({ status: "completed" });
      const pid = Number((yield* starts)[0]?.pid);
      yield* (yield* FileSystem.FileSystem).writeFileString(
        config,
        yield* encodeJson({ agents: {} }),
      );
      expect((yield* agents.overview(project)).agents).toEqual([]);
      yield* until(() => !processAlive(pid), "the removed agent to stop");
      expect(yield* prompt("again")).toEqual({ status: "unavailable", reason: "not_trusted" });
    }),
  );

  it.effect(
    "the agent's permission requests go to the user and are answered once, never always",
    () =>
      Effect.gen(function* () {
        const { prompt, trust } = yield* fakeAgentProject();
        yield* trust;
        expect(yield* prompt("needs permission", { approve: true })).toMatchObject({
          answer: "permission: once",
          toolCalls: [{ title: "Edit README.md", status: "completed" }],
        });
        expect(yield* prompt("needs permission", { approve: false })).toMatchObject({
          answer: "permission: no",
        });
      }),
  );

  it.effect("cancelling sends session/cancel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { log, prompt, trust } = yield* fakeAgentProject();
      yield* trust;
      // The ACP caller cancels its own request through its AbortSignal.
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const pending = yield* Effect.forkChild(prompt("slow", { signal: controller.signal }), {
        startImmediately: true,
      });
      yield* eventually(fs.exists(`${log}.slow`), "the slow prompt to reach the agent");
      controller.abort();
      expect(yield* Fiber.join(pending)).toMatchObject({
        status: "cancelled",
        stopReason: "cancelled",
      });
    }),
  );

  it.effect("slow delegation yields a receipt and cancellation reaches the live ACP agent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { project, sessionId, agents, log, prompt, trust } = yield* fakeAgentProject();
      yield* trust;
      const signal = yield* Effect.abortSignal;
      const delegate = (yield* (yield* DelegateTools).forRun(project, sessionId, signal)).tools[0]!;
      expect(
        yield* sdk(() => delegate.execute!({ agent: "fake", task: "slow task", yieldMs: 0 })),
      ).toMatchObject({ status: "running" });
      yield* eventually(fs.exists(`${log}.slow`), "the background ACP prompt to arrive");
      const tasks = yield* BackgroundTasks;
      yield* tasks.stopSession(sessionId);
      expect(tasks.hasSession(sessionId)).toBe(false);
      expect((yield* agents.overview(project)).agents[0]?.state).toMatchObject({
        status: "trusted",
        link: { status: "connected" },
      });
      expect(yield* prompt("after cancellation")).toMatchObject({ status: "completed" });
    }),
  );

  it.effect(
    "a dropped connection reconnects on its own, stops after two failures in a row, and never resends",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { project, agents, refuse, starts, link, prompt, trust } = yield* fakeAgentProject();
        yield* trust;
        expect(yield* prompt("crash now")).toEqual({
          status: "disconnected",
          answer: "partial before crash",
          toolCalls: [],
        });
        yield* eventually(
          Effect.map(starts, (rows) => rows.length === 2),
          "the automatic reconnect",
        );
        yield* eventually(
          Effect.map(link, (state) => state?.status === "connected"),
          "ACP reconnect",
        );
        // The crashed prompt was not sent again: the new process has seen no prompt.
        expect(yield* prompt("after reconnect")).toMatchObject({
          answer: "external: after reconnect (turn 1)",
        });

        yield* fs.writeFileString(refuse, "");
        yield* prompt("crash again");
        yield* eventually(
          Effect.map(link, (state) => state?.status === "stopped"),
          "ACP reconnect limit",
        );
        expect(yield* link).toMatchObject({ status: "stopped", failures: 2 });
        expect(yield* prompt("while stopped")).toEqual({
          status: "unavailable",
          reason: "stopped_after_failures",
        });

        yield* fs.remove(refuse);
        expect((yield* agents.reconnect(project, "fake")).agents[0]?.state).toMatchObject({
          status: "trusted",
          link: { status: "connected" },
        });
        expect(yield* prompt("back")).toMatchObject({ status: "completed" });
      }),
    30_000,
  );

  it.effect(
    "delegation from a chat needs approval, and the agent's own request is relayed to the page",
    () =>
      Effect.gen(function* () {
        const { sessionId, trust } = yield* fakeAgentProject();
        yield* trust;
        yield* current(selectTestModel());
        const relayed = yield* RelayedApprovals;
        const agent = yield* AgentChat;
        const run = yield* FiberSet.makeRuntimePromise<never>();
        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new ChatClient({
                tools: approvalToolDefinitions,
                interrupts: [permissionReviewInterrupt],
                connection: fetchServerSentEvents("http://127.0.0.1/api/chat", {
                  fetchClient: (input, init) =>
                    run(agent.handle(new Request(input, init), sessionId)),
                }),
              }),
          ),
          (client) => Effect.sync(() => client.dispose()),
        );
        const answer = () =>
          client
            .getMessages()
            .flatMap((message) =>
              message.role === "assistant"
                ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
                : [],
            )
            .join("");

        yield* sdk(() =>
          client.sendMessage(
            'call delegate_to_agent {"agent":"fake","task":"needs permission to edit"}',
          ),
        );
        yield* until(() => client.getInterrupts().length === 1, "approval of the delegation");
        expect(client.getInterrupts()[0]).toMatchObject({
          payload: { toolName: "delegate_to_agent", askedBy: "every_call" },
        });
        client.resolveInterrupts((item) => {
          if (item.kind === "generic") item.resolveInterrupt({ approved: true });
        });
        yield* until(
          () => relayed.pending(sessionId).length === 1,
          "the agent's permission request",
        );
        const [request] = relayed.pending(sessionId);
        expect(request).toMatchObject({
          requester: { kind: "external_agent", agent: "fake" },
          toolName: "Edit README.md",
          askedBy: "agent",
        });
        yield* relayed.answer(sessionId, request!.id, true);
        yield* until(() => answer().includes("permission: once"), "the delegation result");
      }),
    // Three bounded approval/process waits can exceed Vitest's default five seconds under load.
    20_000,
  );
});

// Recalled memory spans every project, so other tests' conversations would leak into the prompt.
testAgent({ testProvider: {} })("direct external agent conversations", (it) => {
  it.effect(
    "a direct conversation with an external agent gets matching memory and is remembered",
    () =>
      Effect.gen(function* () {
        const { project, sessionId: earlier, trust } = yield* fakeAgentProject();
        const nodes = yield* Nodes;
        nodes.append({
          projectId: project.id,
          sessionId: earlier,
          kind: "user",
          text: "로그 포맷은 logfmt로 하기로 했다.",
        });
        yield* (yield* Indexer).indexAll();
        const sessions = yield* Sessions;
        const direct = yield* sessions.create(project.id, null, "fake");
        const untrusted = yield* sessions.create(project.id, null, "fake");

        // Not trusted yet: the conversation cannot start the agent.
        expect((yield* post(untrusted.id, "hello")).status).toBe(409);

        yield* trust;
        // Memory leaves for the external process only once the user allows it.
        const withheld = yield* post(untrusted.id, "로그 포맷 뭐였지?");
        expect(yield* sdk(() => withheld.text())).not.toContain(
          "Memory from context-generactive-agent",
        );
        yield* (yield* GlobalConfig).update({ externalAgentMemory: true });
        const response = yield* post(direct.id, "로그 포맷 뭐였지?");
        expect(response.status).toBe(200);
        const events = yield* sdk(() => response.text());
        expect(events).toContain("Memory from context-generactive-agent");
        expect(events).toContain("logfmt");

        const recorded = nodes.session(direct.id);
        expect(recorded.map((node) => node.kind)).toEqual(["user", "assistant"]);
        expect(recorded[0]?.text).toBe("로그 포맷 뭐였지?");
        expect(recorded[1]?.detail).toMatchObject({ externalAgent: "fake" });
      }),
  );
});
