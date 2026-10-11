import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
// Native ACP processes prove actual OS environment isolation, reconnect and cancellation.
import { fileURLToPath } from "node:url";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import {
  Cause,
  Random,
  Effect,
  Fiber,
  FileSystem,
  Path,
  Schedule,
  Schema,
  MutableHashMap,
  Option,
  Layer,
} from "effect";
import { describe, expect, vi } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { RelayedApprovals } from "../src/approvals/relayed.ts";
import { ExternalAgents, agentCommandInvocation } from "../src/external-agents/agents.ts";
import * as NodePath from "@effect/platform-node/NodePath";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { DelegateTools } from "../src/tools/delegate.ts";
import { BackgroundTasks } from "../src/tools/background.ts";
import { approvalToolDefinitions, permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeAgent = fileURLToPath(new URL("./support/fake-acp-agent.ts", import.meta.url));

const until = Effect.fn("ExternalAgentTest.until")(
  <E, R>(condition: Effect.Effect<boolean, E, R>, what: string) =>
    condition.pipe(
      Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(20) }),
      Effect.timeout(6000),
      Effect.annotateLogs("waitingFor", what),
    ),
);

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const agentSetup = Effect.fn("ExternalAgentTest.setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const join = paths.join;
  const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
  const log = join(context.base, "acp-starts.log");
  const refuse = join(context.base, "refuse");
  yield* fs.makeDirectory(join(context.project.root, ".agents"), { recursive: true });
  yield* fs.writeFileString(
    join(context.project.root, ".agents", "agents.json"),
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      agents: {
        fake: {
          command: process.execPath,
          args: [fakeAgent],
          env: { FAKE_ACP_LOG: log, FAKE_ACP_REFUSE: refuse },
        },
      },
    }),
  );
  const agents = yield* sdkCall(() => context.runtime.runPromise(ExternalAgents));
  const services = yield* context.runtime.contextEffect;
  const run = <A, E>(program: Effect.Effect<A, E>) => Effect.provideContext(program, services);
  const starts = Effect.fn("ExternalAgentTest.starts")(function* () {
    if (!(yield* fs.exists(log))) return [];
    const lines = (yield* fs.readFileString(log)).trim().split("\n");
    return yield* Effect.forEach(lines, (line) =>
      Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            pid: Schema.Int,
            cwd: Schema.String,
            secret: Schema.NullOr(Schema.String),
          }),
        ),
      )(line),
    );
  });
  const linkOf = Effect.fn("ExternalAgentTest.linkOf")(function* () {
    const view = (yield* run(agents.overview(context.project))).agents[0]!;
    return view.state.status === "trusted" ? view.state.link : null;
  });
  const prompt = (text: string, options: { signal?: AbortSignal; approve?: boolean } = {}) =>
    sdkCall((signal) =>
      agents.prompt(context.project, "fake", context.session.id, text, {
        signal: options.signal ?? signal,
        askPermission: () => Promise.resolve(options.approve ?? false),
      }),
    );
  return { ...context, agents, run, starts, refuse, linkOf, prompt, log, fs, join, services };
});

describe("external ACP agents", () => {
  it.live("slow delegation yields a receipt and cancellation reaches the live ACP agent", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const { runtime, agents, run, project, session, log, fs } = yield* agentSetup();
        const signal = yield* Effect.abortSignal;
        yield* run(agents.setTrusted(project, "project", "fake", true));
        const delegateService = yield* Effect.provideContext(
          DelegateTools,
          yield* runtime.contextEffect,
        );
        const delegate = (yield* delegateService.forRun(project, session.id, signal)).tools[0]!;
        const receipt = yield* sdkCall(() =>
          delegate.execute!({ agent: "fake", task: "slow task", yieldMs: 0 }),
        );
        expect(receipt).toMatchObject({ status: "running" });
        yield* until(fs.exists(`${log}.slow`), "the background ACP prompt to arrive");
        const tasks = yield* Effect.provideContext(BackgroundTasks, yield* runtime.contextEffect);
        yield* run(tasks.stopSession(session.id));
        expect(tasks.hasSession(session.id)).toBe(false);
        expect((yield* run(agents.overview(project))).agents[0]?.state).toMatchObject({
          status: "trusted",
          link: { status: "connected" },
        });
        expect(
          yield* sdkCall(() =>
            agents.prompt(project, "fake", session.id, "after cancellation", {
              signal: signal,
              askPermission: () => Promise.resolve(false),
            }),
          ),
        ).toMatchObject({ status: "completed" });
      }),
    ),
  );
  it.live("removing a configured agent closes its live process", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const { agents, run, project, starts, prompt, fs, join } = yield* agentSetup();
        yield* run(agents.setTrusted(project, "project", "fake", true));
        expect(yield* prompt("hi")).toMatchObject({ status: "completed" });
        const pid = Number((yield* starts())[0]?.pid);
        yield* fs.writeFileString(
          join(project.root, ".agents", "agents.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ agents: {} }),
        );

        expect((yield* run(agents.overview(project))).agents).toEqual([]);
        yield* until(
          Effect.sync(() => !processAlive(pid)),
          "the removed agent to stop",
        );
        expect(yield* prompt("again")).toEqual({ status: "unavailable", reason: "not_trusted" });
      }),
    ),
  );

  it.live(
    "an agent starts only once trusted, in the project, without the app's environment",
    () => {
      vi.stubEnv("SHOULD_NOT_LEAK", "app-secret");
      return withTestPlatform(
        Effect.gen(function* () {
          const { agents, run, project, starts, prompt } = yield* agentSetup();
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
          try {
            expect(yield* prompt("hi")).toEqual({ status: "unavailable", reason: "not_trusted" });
            expect(yield* starts()).toEqual([]);

            const trusted = yield* run(agents.setTrusted(project, "project", "fake", true));
            expect(trusted.agents[0]).toMatchObject({
              name: "fake",
              envNames: ["FAKE_ACP_LOG", "FAKE_ACP_REFUSE"],
              state: { status: "trusted", link: { status: "idle" } },
            });
            expect(yield* starts()).toEqual([]);

            expect(yield* prompt("hi")).toMatchObject({
              status: "completed",
              answer: "external: hi (turn 1)",
            });
            // The same conversation continues the agent's session.
            expect(yield* prompt("again")).toMatchObject({ answer: "external: again (turn 2)" });
            expect(yield* starts()).toEqual([
              expect.objectContaining({ cwd: project.root, secret: null }),
            ]);
          } finally {
            vi.unstubAllEnvs();
          }
        }),
      );
    },
  );

  it.live(
    "the agent's permission requests go to the user and are answered once, never always",
    () =>
      withTestPlatform(
        Effect.gen(function* () {
          const { agents, run, project, prompt } = yield* agentSetup();
          yield* run(agents.setTrusted(project, "project", "fake", true));

          expect(yield* prompt("needs permission", { approve: true })).toMatchObject({
            answer: "permission: once",
            toolCalls: [{ title: "Edit README.md", status: "completed" }],
          });
          expect(yield* prompt("needs permission", { approve: false })).toMatchObject({
            answer: "permission: no",
          });
        }),
      ),
  );

  it.live("cancelling sends session/cancel", () => {
    const controller = new AbortController();
    return withTestPlatform(
      Effect.gen(function* () {
        const { agents, run, project, prompt, log, fs } = yield* agentSetup();
        yield* run(agents.setTrusted(project, "project", "fake", true));
        const pending = yield* Effect.forkChild(prompt("slow", { signal: controller.signal }), {
          startImmediately: true,
        });
        yield* until(fs.exists(`${log}.slow`), "the slow prompt to reach the agent");
        controller.abort();
        expect(yield* Fiber.join(pending)).toMatchObject({
          status: "cancelled",
          stopReason: "cancelled",
        });
      }),
    );
  });

  it.live(
    "a dropped connection reconnects on its own, stops after two failures in a row, and never resends",
    () =>
      withTestPlatform(
        Effect.gen(function* () {
          const { agents, run, project, prompt, starts, refuse, linkOf, fs } = yield* agentSetup();
          yield* run(agents.setTrusted(project, "project", "fake", true));

          expect(yield* prompt("crash now")).toEqual({
            status: "disconnected",
            answer: "partial before crash",
            toolCalls: [],
          });
          yield* until(
            starts().pipe(Effect.map((rows) => rows.length === 2)),
            "the automatic reconnect",
          );
          yield* until(
            linkOf().pipe(Effect.map((link) => link?.status === "connected")),
            "ACP reconnect",
          );
          // The crashed prompt was not sent again: the new process has seen no prompt.
          expect(yield* prompt("after reconnect")).toMatchObject({
            answer: "external: after reconnect (turn 1)",
          });

          yield* fs.writeFileString(refuse, "");
          yield* prompt("crash again");
          yield* until(
            linkOf().pipe(Effect.map((link) => link?.status === "stopped")),
            "ACP reconnect limit",
          );
          expect(yield* linkOf()).toMatchObject({ status: "stopped", failures: 2 });
          expect(yield* prompt("while stopped")).toEqual({
            status: "unavailable",
            reason: "stopped_after_failures",
          });

          yield* fs.remove(refuse);
          const reconnected = yield* run(agents.reconnect(project, "fake"));
          expect(reconnected.agents[0]?.state).toMatchObject({
            status: "trusted",
            link: { status: "connected" },
          });
          expect(yield* prompt("back")).toMatchObject({ status: "completed" });
        }),
      ),
    30_000,
  );

  it.live(
    "delegation from a chat needs approval, and the agent's own request is relayed to the page",
    () =>
      withTestPlatform(
        Effect.gen(function* () {
          const context = yield* agentSetup();
          const { runtime, project, session, agents, run, services } = context;
          const runNative = Effect.runPromiseWith(services);
          yield* run(agents.setTrusted(project, "project", "fake", true));
          yield* sdkCall(() => context.provider!.select(runtime));
          const relayed = yield* Effect.provideContext(
            RelayedApprovals,
            yield* runtime.contextEffect,
          );
          const client = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new ChatClient({
                  tools: approvalToolDefinitions,
                  interrupts: [permissionReviewInterrupt],
                  connection: fetchServerSentEvents("http://127.0.0.1/api/chat", {
                    fetchClient: (input, init) =>
                      runNative(
                        Effect.flatMap(AgentChat, (agent) =>
                          agent.handle(new Request(input, init), session.id),
                        ),
                      ),
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

          yield* sdkCall(() =>
            client.sendMessage(
              'call delegate_to_agent {"agent":"fake","task":"needs permission to edit"}',
            ),
          );
          yield* until(
            Effect.sync(() => client.getInterrupts().length === 1),
            "approval of the delegation",
          );
          expect(client.getInterrupts()[0]).toMatchObject({
            payload: { toolName: "delegate_to_agent", askedBy: "every_call" },
          });
          client.resolveInterrupts((item) => {
            if (item.kind === "generic") item.resolveInterrupt({ approved: true });
          });
          yield* until(
            Effect.sync(() => relayed.pending(session.id).length === 1),
            "the agent's permission request",
          );
          const [request] = relayed.pending(session.id);
          expect(request).toMatchObject({
            requester: { kind: "external_agent", agent: "fake" },
            toolName: "Edit README.md",
            askedBy: "agent",
          });
          yield* relayed.answer(session.id, request!.id, true);
          yield* until(
            Effect.sync(() => answer().includes("permission: once")),
            "the delegation result",
          );
        }),
      ),
    // Three bounded approval/process waits can exceed Vitest's default five seconds under load.
    20_000,
  );

  it.live(
    "a direct conversation with an external agent gets matching memory and is remembered",
    () =>
      withTestPlatform(
        Effect.gen(function* () {
          const { runtime, project, session: earlier, agents, run, services } = yield* agentSetup();
          const { direct, untrusted } = yield* Effect.provideContext(
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
            yield* runtime.contextEffect,
          );
          const send = Effect.fn("ExternalAgentTest.send")(function* (
            sessionId: string,
            text: string,
          ) {
            const request = new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                threadId: sessionId,
                runId: `run-${(yield* Random.next).toString(36).slice(2)}`,
                messages: [{ id: "m1", role: "user", content: text }],
                tools: [],
                context: [],
              }),
            });
            return yield* Effect.provideContext(
              Effect.flatMap(AgentChat, (agent) => agent.handle(request, sessionId)),
              services,
            );
          });

          // Not trusted yet: the conversation cannot start the agent.
          expect((yield* send(untrusted.id, "hello")).status).toBe(409);

          yield* run(agents.setTrusted(project, "project", "fake", true));
          const response = yield* send(direct.id, "로그 포맷 뭐였지?");
          expect(response.status).toBe(200);
          const events = yield* sdkCall(() => response.text());
          expect(events).toContain("Memory from context-generactive-agent");
          expect(events).toContain("logfmt");

          const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
          const recorded = nodes.session(direct.id);
          expect(recorded.map((node) => node.kind)).toEqual(["user", "assistant"]);
          expect(recorded[0]?.text).toBe("로그 포맷 뭐였지?");
          expect(recorded[1]?.detail).toMatchObject({ externalAgent: "fake" });
        }),
      ),
  );
});

const sdkCall = Effect.fn("ExternalAgentTest.sdkCall")(
  <A>(call: (signal: AbortSignal) => A | PromiseLike<A>) =>
    Effect.tryPromise({
      try: (signal) => Promise.resolve(call(signal)),
      catch: (cause) => new Cause.UnknownError(cause),
    }),
);

const windowsInvocation = Effect.fn("ExternalAgentTest.windowsInvocation")(function* (
  command: string,
  args: readonly string[],
  files: readonly (readonly [string, string])[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const metadataPath = path.join(directory, "metadata");
  yield* fs.writeFileString(metadataPath, "");
  const fileInfo = yield* fs.stat(metadataPath);
  const knownFiles = MutableHashMap.fromIterable(
    files.map(([name, text]) => [name.toLowerCase(), text] as const),
  );
  const missing = FileSystem.makeNoop({});
  const fixtureFs = FileSystem.makeNoop({
    stat: (name) =>
      MutableHashMap.has(knownFiles, name.toLowerCase())
        ? Effect.succeed(fileInfo)
        : missing.stat(name),
    readFileString: (name) =>
      Option.match(MutableHashMap.get(knownFiles, name.toLowerCase()), {
        onNone: () => missing.readFileString(name),
        onSome: Effect.succeed,
      }),
  });
  const paths = yield* Layer.build(NodePath.layerWin32);
  return yield* agentCommandInvocation({
    command,
    args,
    cwd: "C:\\work",
    env: {
      Path: "C:\\tools;C:\\work\\node_modules\\.bin",
      PATHEXT: ".EXE;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
    platform: "win32",
  }).pipe(Effect.provideContext(paths), Effect.provideService(FileSystem.FileSystem, fixtureFs));
});

it.effect("Windows exe launch preserves literal arguments without a shell", () =>
  Effect.gen(function* () {
    expect(
      yield* windowsInvocation("tool", ["a&b", "%PATH%"], [["C:\\tools\\tool.exe", ""]]),
    ).toEqual({ command: "tool", args: ["a&b", "%PATH%"], shell: undefined });
  }).pipe(withTestPlatform),
);
it.effect("Windows npm command shim escapes metacharacters for both cmd passes", () =>
  Effect.gen(function* () {
    expect(
      yield* windowsInvocation(
        "npx",
        ["a&b", "%PATH%"],
        [["C:\\work\\node_modules\\.bin\\npx.cmd", "@echo off"]],
      ),
    ).toEqual({
      command: 'npx ^^^"a^^^&b^^^" ^^^"^^^%PATH^^^%^^^"',
      args: [],
      shell: "C:\\Windows\\System32\\cmd.exe",
    });
  }).pipe(withTestPlatform),
);
it.effect.each([
  "#!/usr/bin/env node --trace-warnings --no-warnings",
  "#!/usr/bin/node --trace-warnings --no-warnings",
])("Windows shebang preserves interpreter flags: %s", (shebang) =>
  Effect.gen(function* () {
    expect(
      yield* windowsInvocation(
        "script",
        ["payload"],
        [
          ["C:\\work\\script", shebang],
          ["C:\\tools\\node.exe", ""],
        ],
      ),
    ).toEqual({
      command: "node",
      args: ["--trace-warnings", "--no-warnings", "C:\\work\\script", "payload"],
      shell: undefined,
    });
  }).pipe(withTestPlatform),
);
