// Native ACP processes prove actual OS environment isolation, reconnect and cancellation.
import { Effect, Fiber, FileSystem, Path, Schedule, Schema, Stream } from "effect";
import { expect, vi } from "vite-plus/test";
import { GlobalConfig } from "../../src/config/global-config.ts";
import { RelayedApprovals } from "../../src/approvals/relayed.ts";
import { ApprovalRequester } from "../../src/approvals/relayed-state.ts";
import {
  AgentLinkState,
  AgentTrustState,
  ExternalAgents,
  ExternalPromptOutcome,
} from "../../src/external-agents/agents.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { AgUiEvent } from "../../src/loop/chunks.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { BackgroundTasks } from "../../src/tools/background.ts";
import { DelegateTools } from "../../src/tools/delegate.ts";
import { chatApi } from "../support/chat-api.ts";
import { openPage } from "../support/chat-client.ts";
import { selectTestModel } from "../support/provider.ts";
import { callTool } from "../support/run-tools.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { current, encodeJson, freshProject, until } from "./agent-env.ts";

const isTextContent = AgUiEvent.guards.TEXT_MESSAGE_CONTENT;

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
/** A trusted agent whose link is connected, whatever it named itself. */
const isConnected = (state: AgentTrustState | undefined) =>
  state !== undefined &&
  AgentTrustState.$is("trusted")(state) &&
  AgentLinkState.$is("connected")(state.link);

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
  const fakeAgent = yield* path.fromFileUrl(
    new URL("../support/fake-acp-agent.ts", import.meta.url),
  );
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
  const link = Effect.map(agents.overview(project), ({ agents: [view] }) =>
    view !== undefined && AgentTrustState.$is("trusted")(view.state) ? view.state.link : null,
  );
  const prompt = (text: string, options: { approve?: boolean } = {}) =>
    agents.prompt(project, "fake", sessionId, text, {
      askPermission: () => Effect.succeed(options.approve ?? false),
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
        expect(yield* prompt("hi")).toEqual(
          ExternalPromptOutcome.unavailable({ failure: { code: "not_trusted", detail: null } }),
        );
        expect(yield* starts).toEqual([]);

        const trusted = yield* trust;
        expect(trusted.agents[0]).toMatchObject({
          name: "fake",
          envNames: ["FAKE_ACP_LOG", "FAKE_ACP_REFUSE"],
          state: AgentTrustState.trusted({ link: AgentLinkState.idle() }),
        });
        expect(yield* starts).toEqual([]);

        const first = yield* prompt("hi");
        expect(ExternalPromptOutcome.$is("completed")(first)).toBe(true);
        expect(first).toMatchObject({ answer: "external: hi (turn 1)" });
        // The same conversation continues the agent's session.
        expect(yield* prompt("again")).toMatchObject({ answer: "external: again (turn 2)" });
        expect(yield* starts).toEqual([
          expect.objectContaining({ cwd: project.root, secret: null }),
        ]);
      }),
  );

  it.effect("a failed start is shown by its code, the agent's own text with secrets hidden", () =>
    Effect.gen(function* () {
      const { project, agents, config, link, prompt } = yield* fakeAgentProject();
      yield* (yield* FileSystem.FileSystem).writeFileString(
        config,
        yield* encodeJson({ agents: { fake: { command: "/nonexistent/API_KEY=zq81Hd72kdP0xQ" } } }),
      );
      yield* agents.setTrusted(project, "project", "fake", true);
      const outcome = yield* prompt("hi");
      const failure = {
        code: "spawn_failed" as const,
        detail: expect.stringContaining("API_KEY="),
      };
      expect(outcome).toEqual(ExternalPromptOutcome.unavailable({ failure }));
      expect(yield* link).toEqual(AgentLinkState.retrying({ failures: 1, failure }));
      // The settings page's command line hides the same value.
      const listed = yield* agents.overview(project);
      expect(listed.agents[0]?.target).toContain("API_KEY=");
      expect(yield* encodeJson([outcome, yield* link, listed])).not.toContain("zq81Hd72kdP0xQ");
    }),
  );

  it.effect("removing a configured agent closes its live process", () =>
    Effect.gen(function* () {
      const { project, agents, config, starts, prompt, trust } = yield* fakeAgentProject();
      yield* trust;
      expect(ExternalPromptOutcome.$is("completed")(yield* prompt("hi"))).toBe(true);
      const pid = Number((yield* starts)[0]?.pid);
      yield* (yield* FileSystem.FileSystem).writeFileString(
        config,
        yield* encodeJson({ agents: {} }),
      );
      expect((yield* agents.overview(project)).agents).toEqual([]);
      yield* until(() => !processAlive(pid), "the removed agent to stop");
      expect(yield* prompt("again")).toEqual(
        ExternalPromptOutcome.unavailable({ failure: { code: "not_trusted", detail: null } }),
      );
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

  it.effect("interrupting a prompt sends session/cancel and waits for the agent's answer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { log, prompt, trust } = yield* fakeAgentProject();
      yield* trust;
      const pending = yield* Effect.forkChild(prompt("slow"), { startImmediately: true });
      yield* eventually(fs.exists(`${log}.slow`), "the slow prompt to reach the agent");
      yield* Fiber.interrupt(pending);
      expect(yield* fs.exists(`${log}.cancelled`)).toBe(true);
    }),
  );

  it.effect("slow delegation yields a receipt and cancellation reaches the live ACP agent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { project, sessionId, agents, log, prompt, trust } = yield* fakeAgentProject();
      yield* trust;
      const { tools } = yield* (yield* DelegateTools).runToolsFor({
        project,
        sessionId,
        signal: yield* Effect.abortSignal,
        runId: `${sessionId}:run`,
      });
      expect(
        yield* callTool(tools, "delegate_to_agent", {
          agent: "fake",
          task: "slow task",
          yieldMs: 0,
        }),
      ).toMatchObject({ status: "running" });
      yield* eventually(fs.exists(`${log}.slow`), "the background ACP prompt to arrive");
      const tasks = yield* BackgroundTasks;
      yield* tasks.stopSession(sessionId);
      expect(tasks.hasSession(sessionId)).toBe(false);
      expect(isConnected((yield* agents.overview(project)).agents[0]?.state)).toBe(true);
      expect(ExternalPromptOutcome.$is("completed")(yield* prompt("after cancellation"))).toBe(
        true,
      );
    }),
  );

  it.effect("a quick delegation returns the agent's report inline", () =>
    Effect.gen(function* () {
      const { project, sessionId, trust } = yield* fakeAgentProject();
      yield* trust;
      const { tools } = yield* (yield* DelegateTools).runToolsFor({
        project,
        sessionId,
        signal: yield* Effect.abortSignal,
        runId: `${sessionId}:run`,
      });
      expect(
        yield* callTool(tools, "delegate_to_agent", { agent: "fake", task: "hi", yieldMs: 5000 }),
      ).toMatchObject({
        agent: "fake",
        status: "completed",
        answer: "external: hi (turn 1)",
      });
    }),
  );

  it.effect(
    "a dropped connection reconnects on its own, stops after two failures in a row, and never resends",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { project, agents, refuse, starts, link, prompt, trust } = yield* fakeAgentProject();
        yield* trust;
        expect(yield* prompt("crash now")).toEqual(
          ExternalPromptOutcome.disconnected({ answer: "partial before crash", toolCalls: [] }),
        );
        yield* eventually(
          Effect.map(starts, (rows) => rows.length === 2),
          "the automatic reconnect",
        );
        yield* eventually(
          Effect.map(link, (state) => state !== null && AgentLinkState.$is("connected")(state)),
          "ACP reconnect",
        );
        // The crashed prompt was not sent again: the new process has seen no prompt.
        expect(yield* prompt("after reconnect")).toMatchObject({
          answer: "external: after reconnect (turn 1)",
        });

        yield* fs.writeFileString(refuse, "");
        yield* prompt("crash again");
        yield* eventually(
          Effect.map(link, (state) => state !== null && AgentLinkState.$is("stopped")(state)),
          "ACP reconnect limit",
        );
        const stopped = yield* link;
        expect(stopped !== null && AgentLinkState.$is("stopped")(stopped) && stopped.failures).toBe(
          2,
        );
        expect(yield* prompt("while stopped")).toEqual(
          ExternalPromptOutcome.unavailable({
            failure: { code: "stopped_after_failures", detail: null },
          }),
        );

        yield* fs.remove(refuse);
        expect(isConnected((yield* agents.reconnect(project, "fake")).agents[0]?.state)).toBe(true);
        expect(ExternalPromptOutcome.$is("completed")(yield* prompt("back"))).toBe(true);
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
        const page = yield* openPage(sessionId);
        // The delegation waits for its report inline, however long the relayed answer takes.
        yield* page.send(
          'call delegate_to_agent {"agent":"fake","task":"needs permission to edit","yieldMs":15000}',
        );
        expect(page.pending()).toMatchObject([
          {
            reason: "permission_review",
            metadata: { payload: { toolName: "delegate_to_agent", askedBy: "every_call" } },
          },
        ]);
        const resumed = yield* Effect.forkChild(
          page.resolve(() => true),
          {
            startImmediately: true,
          },
        );
        yield* until(
          Effect.map(relayed.pending(sessionId), (pending) => pending.length === 1),
          "the agent's permission request",
        );
        const [request] = yield* relayed.pending(sessionId);
        expect(request).toMatchObject({
          requester: ApprovalRequester.cases.external_agent.make({ agent: "fake" }),
          toolName: "Edit README.md",
          askedBy: "agent",
        });
        yield* relayed.answer(sessionId, request!.id, true);
        yield* Fiber.join(resumed);
        expect(page.answer()).toContain("permission: once");
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
        yield* nodes.append({
          projectId: project.id,
          sessionId: earlier,
          kind: "user",
          text: "로그 포맷은 logfmt로 하기로 했다.",
        });
        yield* (yield* Indexer).indexAll();
        const sessions = yield* Sessions;
        const direct = yield* sessions.create(project.id, null, "fake");
        const untrusted = yield* sessions.create(project.id, null, "fake");

        const api = yield* chatApi;
        const answer = (session: string, runId: string, text: string) =>
          api
            .run({
              params: { session },
              headers: {},
              payload: { runId, messages: [{ id: `${runId}:user`, role: "user", content: text }] },
            })
            .pipe(
              Effect.flatMap(Stream.runCollect),
              Effect.map((events) =>
                events.flatMap(({ data }) => (isTextContent(data) ? [data.delta] : [])).join(""),
              ),
            );

        // Not trusted yet: the conversation cannot start the agent.
        expect(yield* Effect.flip(answer(untrusted.id, "untrusted-1", "hello"))).toMatchObject({
          error: "external_agent_unavailable",
        });

        yield* trust;
        // Memory leaves for the external process only once the user allows it.
        expect(yield* answer(untrusted.id, "untrusted-2", "로그 포맷 뭐였지?")).not.toContain(
          "Memory from context-generactive-agent",
        );
        yield* (yield* GlobalConfig).update({ externalAgentMemory: true });
        const answered = yield* answer(direct.id, "direct-1", "로그 포맷 뭐였지?");
        expect(answered).toContain("Memory from context-generactive-agent");
        expect(answered).toContain("logfmt");

        const recorded = yield* nodes.session(direct.id);
        expect(recorded.map((node) => node.kind)).toEqual(["user", "assistant"]);
        expect(recorded[0]?.text).toBe("로그 포맷 뭐였지?");
        expect(recorded[1]?.detail).toMatchObject({ externalAgent: "fake" });
      }),
  );
});
