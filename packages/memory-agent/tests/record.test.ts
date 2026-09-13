import { chat, toolDefinition } from "@tanstack/ai";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Nodes } from "../src/memory/nodes.ts";
import { Recorder } from "../src/memory/record.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { toToolSchema } from "../src/tools/schema.ts";
import { testRuntime } from "./support/runtime.ts";

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

async function drain(stream: AsyncIterable<unknown>) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("Recorder", () => {
  test("stores every message of a tool-using run with structural edges", async () => {
    const { runtime, project, session } = await testRuntime();
    const nodes = await runtime.runPromise(Nodes);
    const recorder = await runtime.runPromise(Recorder);

    const user = nodes.append({
      projectId: project.id,
      sessionId: session.id,
      kind: "user",
      text: "README 읽고 테스트 돌려줘",
    });
    const adapter = new ScriptedTextAdapter([
      {
        text: "먼저 README를 읽고 테스트를 실행할게요.",
        toolCalls: [
          { id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' },
          { id: "call-2", name: "run_tests", arguments: "{}" },
        ],
      },
      { text: "README는 Vite+ 사용법이고, 테스트 2개가 실패했습니다." },
    ]);
    await drain(
      chat({
        adapter,
        messages: [{ role: "user", content: user.text }],
        tools: [readFile, runTests],
        runId: "run-1",
        middleware: [
          recorder.forRun({
            projectId: project.id,
            sessionId: session.id,
            runId: "run-1",
            userNodeId: user.id,
          }),
        ],
      }),
    );

    const stored = nodes.session(session.id);
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
      ["tool_result", "2 tests failed", { toolName: "run_tests", toolCallId: "call-2", ok: false }],
      ["assistant", "README는 Vite+ 사용법이고, 테스트 2개가 실패했습니다.", {}],
    ]);
    expect(stored.every((node) => node.runId === "run-1" || node.kind === "user")).toBe(true);

    const [, firstAnswer, readCall, readResult, testCall, testResult, finalAnswer] = stored;
    const kindsFrom = (id: string) =>
      nodes
        .edgesOf(id)
        .filter((edge) => edge.fromId === id)
        .map((edge) => [edge.kind, edge.toId]);
    expect(kindsFrom(firstAnswer!.id)).toEqual(
      expect.arrayContaining([
        ["reply", user.id],
        ["calls", readCall!.id],
        ["calls", testCall!.id],
        ["next", readCall!.id],
      ]),
    );
    expect(kindsFrom(readCall!.id)).toEqual(expect.arrayContaining([["returns", readResult!.id]]));
    expect(kindsFrom(testCall!.id)).toEqual(expect.arrayContaining([["returns", testResult!.id]]));
    expect(kindsFrom(finalAnswer!.id)).toEqual([["reply", user.id]]);
  });

  test("links nodes that refer to the same file across runs", async () => {
    const { runtime, project, session } = await testRuntime();
    const nodes = await runtime.runPromise(Nodes);
    const recorder = await runtime.runPromise(Recorder);

    for (const runId of ["run-a", "run-b"]) {
      const user = nodes.append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: `${runId}: README 확인`,
      });
      await drain(
        chat({
          adapter: new ScriptedTextAdapter([
            {
              toolCalls: [
                { id: `${runId}-call`, name: "read_file", arguments: '{"path":"README.md"}' },
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

    const calls = nodes.session(session.id).filter((node) => node.kind === "tool_call");
    expect(calls).toHaveLength(2);
    const touches = nodes.edgesOf(calls[1]!.id).filter((edge) => edge.kind === "touches");
    expect(touches.map((edge) => [edge.fromId, edge.toId])).toEqual([[calls[1]!.id, calls[0]!.id]]);
  });

  test("keeps the partial answer when the model call fails mid-run", async () => {
    const { runtime, project, session } = await testRuntime();
    const nodes = await runtime.runPromise(Nodes);
    const recorder = await runtime.runPromise(Recorder);
    const user = nodes.append({
      projectId: project.id,
      sessionId: session.id,
      kind: "user",
      text: "길게 설명해줘",
    });

    await drain(
      chat({
        adapter: new ScriptedTextAdapter([
          { text: "설명을 시작하면, 먼저", failAfterText: "provider connection reset" },
        ]),
        messages: [{ role: "user", content: user.text }],
        runId: "run-fail",
        middleware: [
          recorder.forRun({
            projectId: project.id,
            sessionId: session.id,
            runId: "run-fail",
            userNodeId: user.id,
          }),
        ],
      }),
    ).catch(() => undefined);

    const answer = nodes.session(session.id).at(-1);
    expect(answer).toMatchObject({
      kind: "assistant",
      text: "설명을 시작하면, 먼저",
      detail: { partial: true, reason: "provider connection reset" },
    });
  });
});
