import { layer } from "@effect/vitest";
import { chat, toolDefinition } from "@tanstack/ai";
import { Cause, Context, Effect, Layer, Schema, Scope, Stream } from "effect";
import { expect } from "vite-plus/test";
import { Nodes } from "../../src/memory/nodes.ts";
import { makeRecordingMiddleware, Recorder } from "../../src/memory/record.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { toToolSchema } from "../../src/tools/schema.ts";
import { TestEnv } from "../support/test-env.ts";

const secret = `${"gh"}p_${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"}`;

const readFile = toolDefinition({
  name: "read_file",
  description: "Read a project file",
  inputSchema: toToolSchema(Schema.Struct({ path: Schema.String })),
}).server(({ path }) => ({ path, content: "# Vite+\r\n사용법" }));

const runTests = toolDefinition({
  name: "run_tests",
  description: "Run the test suite",
  inputSchema: toToolSchema(Schema.Struct({})),
}).server(() => {
  throw new Error("2 tests failed");
});

const drain = (stream: AsyncIterable<unknown>) =>
  Stream.runDrain(Stream.fromAsyncIterable(stream, (cause) => new Cause.UnknownError(cause)));

/** A second agent over its own storage, to check what is bound to which owner. */
class OtherAgent extends Context.Service<OtherAgent, TestEnv["Service"]>()(
  "memory-agent/tests/memory/record.test/OtherAgent",
) {}

// Layers memoize by reference, so the second agent gets its own memo map; otherwise it would share
// the first agent's services.
const otherAgent = Layer.effect(
  OtherAgent,
  Effect.gen(function* () {
    const context = yield* Layer.buildWithMemoMap(
      TestEnv.layer(),
      yield* Layer.makeMemoMap,
      yield* Scope.Scope,
    );
    return Context.get(context, TestEnv);
  }),
);

/** A fresh session in the open agent, with the user turn a run answers. */
const userTurn = Effect.fnUntraced(function* (text: string) {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  const user = yield* (yield* Nodes).append({
    projectId: project.id,
    sessionId: session.id,
    kind: "user",
    text,
  });
  return { project, session, user };
});

layer(otherAgent.pipe(Layer.provideMerge(TestEnv.layer())), { excludeTestServices: true })(
  "Recorder",
  (it) => {
    it.effect("stores every message of a tool-using run with structural edges", () =>
      Effect.gen(function* () {
        const { project, session, user } = yield* userTurn("README 읽고 테스트 돌려줘");
        const nodes = yield* Nodes;
        const runId = `${session.id}:run`;
        yield* drain(
          chat({
            threadId: "thread",
            adapter: new ScriptedTextAdapter([
              {
                text: "먼저 README를 읽고 테스트를 실행할게요.",
                toolCalls: [
                  { id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' },
                  { id: "call-2", name: "run_tests", arguments: "{}" },
                ],
              },
              { text: "README는 Vite+ 사용법이고, 테스트 2개가 실패했습니다." },
            ]),
            messages: [{ role: "user", content: user.text }],
            tools: [readFile, runTests],
            runId,
            middleware: [
              (yield* Recorder).forRun({
                projectId: project.id,
                sessionId: session.id,
                runId,
                userNodeId: user.id,
              }),
            ],
          }),
        );

        const stored = yield* nodes.session(session.id);
        expect(stored.map((node) => [node.kind, node.text, node.detail])).toEqual([
          ["user", "README 읽고 테스트 돌려줘", {}],
          ["assistant", "먼저 README를 읽고 테스트를 실행할게요.", {}],
          [
            "tool_call",
            'read_file {"path":"README.md"}',
            { toolName: "read_file", toolCallId: "call-1" },
          ],
          [
            "tool_result",
            '{"path":"README.md","content":"# Vite+\\r\\n사용법"}',
            { toolName: "read_file", toolCallId: "call-1", ok: true },
          ],
          ["tool_call", "run_tests {}", { toolName: "run_tests", toolCallId: "call-2" }],
          [
            "tool_result",
            "2 tests failed",
            { toolName: "run_tests", toolCallId: "call-2", ok: false },
          ],
          ["assistant", "README는 Vite+ 사용법이고, 테스트 2개가 실패했습니다.", {}],
        ]);
        expect(stored.every((node) => node.runId === runId || node.kind === "user")).toBe(true);

        const [, firstAnswer, readCall, readResult, testCall, testResult, finalAnswer] = stored;
        const kindsFrom = (id: string) =>
          Effect.map(nodes.edgesOf(id), (edges) =>
            edges.filter((edge) => edge.fromId === id).map((edge) => [edge.kind, edge.toId]),
          );
        expect(yield* kindsFrom(firstAnswer!.id)).toEqual(
          expect.arrayContaining([
            ["reply", user.id],
            ["calls", readCall!.id],
            ["calls", testCall!.id],
            ["next", readCall!.id],
          ]),
        );
        expect(yield* kindsFrom(readCall!.id)).toEqual(
          expect.arrayContaining([["returns", readResult!.id]]),
        );
        expect(yield* kindsFrom(testCall!.id)).toEqual(
          expect.arrayContaining([["returns", testResult!.id]]),
        );
        expect(yield* kindsFrom(finalAnswer!.id)).toEqual([["reply", user.id]]);
      }),
    );

    it.effect("a shell command that exits non-zero is not recorded as ok", () =>
      Effect.gen(function* () {
        const { project, session, user } = yield* userTurn("테스트 돌려줘");
        const runId = `${session.id}:run`;
        const shell = toolDefinition({
          name: "run_shell",
          description: "Run a command",
          inputSchema: toToolSchema(Schema.Struct({ command: Schema.String })),
        }).server(({ command }) => ({
          workdir: ".",
          command,
          shell: "zsh",
          status: "failed",
          exitCode: 1,
          signal: null,
          durationMs: 10,
          stdout: "",
          stderr: "2 failed",
          stdoutTruncated: false,
          stderrTruncated: false,
        }));
        yield* drain(
          chat({
            threadId: "thread",
            adapter: new ScriptedTextAdapter([
              {
                text: "",
                toolCalls: [
                  { id: "call-1", name: "run_shell", arguments: '{"command":"vp test"}' },
                ],
              },
              { text: "테스트가 실패했어요." },
            ]),
            messages: [{ role: "user", content: user.text }],
            tools: [shell],
            runId,
            middleware: [
              (yield* Recorder).forRun({
                projectId: project.id,
                sessionId: session.id,
                runId,
                userNodeId: user.id,
              }),
            ],
          }),
        );
        const result = yield* (yield* Nodes).toolNode(session.id, "tool_result", "call-1");
        expect(result?.detail).toMatchObject({ toolName: "run_shell", ok: false });
      }),
    );

    it.effect("links nodes that refer to the same file across runs", () =>
      Effect.gen(function* () {
        const { project } = yield* TestEnv;
        const session = yield* (yield* Sessions).create(project.id);
        const nodes = yield* Nodes;
        const recorder = yield* Recorder;
        for (const run of ["a", "b"]) {
          const runId = `${session.id}:${run}`;
          const user = yield* nodes.append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: `${run}: README 확인`,
          });
          yield* drain(
            chat({
              threadId: "thread",
              adapter: new ScriptedTextAdapter([
                {
                  toolCalls: [
                    { id: `${run}-call`, name: "read_file", arguments: '{"path":"README.md"}' },
                  ],
                },
                { text: "확인했습니다." },
              ]),
              messages: [{ role: "user", content: user.text }],
              tools: [readFile],
              runId,
              middleware: [
                recorder.forRun({
                  projectId: project.id,
                  sessionId: session.id,
                  runId,
                  userNodeId: user.id,
                }),
              ],
            }),
          );
        }

        const calls = (yield* nodes.session(session.id)).filter(
          (node) => node.kind === "tool_call",
        );
        expect(calls).toHaveLength(2);
        const touches = (yield* nodes.edgesOf(calls[1]!.id)).filter(
          (edge) => edge.kind === "touches",
        );
        expect(touches.map((edge) => [edge.fromId, edge.toId])).toEqual([
          [calls[1]!.id, calls[0]!.id],
        ]);
      }),
    );

    it.effect("keeps the partial answer when the model call fails mid-run", () =>
      Effect.gen(function* () {
        const { project, session, user } = yield* userTurn("길게 설명해줘");
        const runId = `${session.id}:fail`;
        yield* drain(
          chat({
            threadId: "thread",
            adapter: new ScriptedTextAdapter([
              { text: "설명을 시작하면, 먼저", failAfterText: "provider connection reset" },
            ]),
            messages: [{ role: "user", content: user.text }],
            runId,
            middleware: [
              (yield* Recorder).forRun({
                projectId: project.id,
                sessionId: session.id,
                runId,
                userNodeId: user.id,
              }),
            ],
          }),
        ).pipe(Effect.ignore);

        expect((yield* (yield* Nodes).session(session.id)).at(-1)).toMatchObject({
          kind: "assistant",
          text: "설명을 시작하면, 먼저",
          detail: { partial: true, reason: "provider connection reset" },
        });
      }),
    );

    it.effect(
      "native recording factories isolate reused call IDs and defer user binding on central services",
      () =>
        Effect.gen(function* () {
          const { project } = yield* TestEnv;
          const nodes = yield* Nodes;
          const reviews = yield* PermissionReviews;
          const sessions = yield* Sessions;
          expect((yield* Recorder).factory).toBe(makeRecordingMiddleware);
          const first = yield* sessions.create(project.id);
          const second = yield* sessions.create(project.id);
          const executions = [
            { session: first, runId: `${first.id}:failed`, fail: true, decision: "denied" },
            { session: second, runId: `${second.id}:ok`, fail: false, decision: "approved" },
          ] as const;
          yield* Effect.forEach(
            executions,
            Effect.fnUntraced(function* (entry) {
              const user = yield* nodes.append({
                projectId: project.id,
                sessionId: entry.session.id,
                kind: "user",
                text: "test",
              });
              let reads = 0;
              let currentUserId = "not-yet-bound";
              const middleware = yield* makeRecordingMiddleware({
                projectId: project.id,
                sessionId: entry.session.id,
                runId: entry.runId,
                get userNodeId() {
                  reads++;
                  return currentUserId;
                },
              });
              expect(reads).toBe(0);
              currentUserId = user.id;
              yield* reviews.record({
                sessionId: entry.session.id,
                toolCallId: "shared-call",
                toolName: "probe",
                input: "{}",
                decision: entry.decision,
                decidedBy: "user",
                reason: entry.runId,
              });
              const tool = toolDefinition({
                name: "probe",
                description: "Deterministic recording probe",
                inputSchema: toToolSchema(Schema.Struct({})),
              }).server(() => {
                if (entry.fail) throw new Error(`failed ${secret}`);
                return `success ${secret}`;
              });
              yield* drain(
                chat({
                  threadId: "thread",
                  adapter: new ScriptedTextAdapter([
                    {
                      text: `starting ${secret}`,
                      toolCalls: [{ id: "shared-call", name: "probe", arguments: "{}" }],
                    },
                    { text: `finished ${secret}` },
                  ]),
                  messages: [{ role: "user", content: user.text }],
                  tools: [tool],
                  runId: entry.runId,
                  middleware: [middleware],
                }),
              );
              expect(reads).toBeGreaterThan(0);
              const stored = yield* nodes.session(entry.session.id);
              expect(
                yield* nodes.toolNode(entry.session.id, "tool_result", "shared-call"),
              ).toMatchObject({
                runId: entry.runId,
                text: `${entry.fail ? "failed" : "success"} [redacted:github]`,
                detail: {
                  ok: !entry.fail,
                  permission: { decision: entry.decision, decidedBy: "user", reason: entry.runId },
                },
              });
              expect(stored.filter((node) => node.kind === "tool_result")).toHaveLength(1);
              expect(stored.filter((node) => node.kind === "tool_call")).toHaveLength(1);
              expect(stored.map((node) => node.text).join("\n")).not.toContain(secret);
              for (const assistant of stored.filter((node) => node.kind === "assistant")) {
                expect(yield* nodes.edgesOf(assistant.id)).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ kind: "reply", fromId: assistant.id, toId: user.id }),
                  ]),
                );
              }
            }),
            { concurrency: "unbounded" },
          );
        }),
    );

    it.effect("one unbound factory reference uses each agent's current native owner context", () =>
      Effect.gen(function* () {
        const factory = (yield* Recorder).factory;
        const recordHello = Effect.fnUntraced(function* () {
          const { project } = yield* TestEnv;
          const session = yield* (yield* Sessions).create(project.id);
          const nodes = yield* Nodes;
          const user = yield* nodes.append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "hello",
          });
          const middleware = yield* factory({
            projectId: project.id,
            sessionId: session.id,
            runId: `${session.id}:run`,
            userNodeId: user.id,
          });
          yield* drain(
            chat({
              threadId: "thread",
              adapter: new ScriptedTextAdapter([{ text: "owner answer" }]),
              messages: [{ role: "user", content: "hello" }],
              middleware: [middleware],
            }),
          );
          expect((yield* nodes.session(session.id)).map((node) => node.text)).toEqual([
            "hello",
            "owner answer",
          ]);
          return session.id;
        });
        yield* recordHello();
        const other = yield* OtherAgent;
        const otherSession = yield* other.use(
          recordHello().pipe(Effect.provideService(TestEnv, other)),
        );
        expect(yield* (yield* Nodes).session(otherSession)).toEqual([]);
      }),
    );
  },
);
