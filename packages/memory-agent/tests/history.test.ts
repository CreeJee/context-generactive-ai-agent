import { describe, expect, test } from "vite-plus/test";
import { sessionMessages } from "../src/agent/history.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { testRuntime } from "./support/runtime.ts";

describe("sessionMessages", () => {
  test("groups a run's text, tool calls and results into one assistant message", async () => {
    const { runtime, project, session } = await testRuntime();
    const nodes = await runtime.runPromise(Nodes);
    const at = { projectId: project.id, sessionId: session.id };
    const user = nodes.append({ ...at, kind: "user", text: "DB 뭐로 했지?" });
    const empty = nodes.append({ ...at, runId: "r1", kind: "assistant", text: "" });
    nodes.append({
      ...at,
      runId: "r1",
      kind: "tool_call",
      text: 'find_memory {"query":"DB"}',
      detail: { toolName: "find_memory", toolCallId: "c1" },
    });
    nodes.append({
      ...at,
      runId: "r1",
      kind: "tool_result",
      text: '{"matches":[]}',
      detail: { toolName: "find_memory", toolCallId: "c1", ok: true },
    });
    nodes.append({ ...at, runId: "r1", kind: "assistant", text: "SQLite로 했어요." });
    nodes.append({ ...at, kind: "user", text: "고마워" });

    const messages = sessionMessages(nodes.session(session.id), () => []);
    expect(messages.map((message) => [message.role, message.parts])).toEqual([
      ["user", [{ type: "text", content: "DB 뭐로 했지?" }]],
      [
        "assistant",
        [
          {
            type: "tool-call",
            id: "c1",
            name: "find_memory",
            arguments: '{"query":"DB"}',
            state: "input-complete",
          },
          { type: "tool-result", toolCallId: "c1", content: '{"matches":[]}', state: "complete" },
          { type: "text", content: "SQLite로 했어요." },
        ],
      ],
      ["user", [{ type: "text", content: "고마워" }]],
    ]);
    expect(messages[0]!.id).toBe(user.id);
    expect(messages[1]!.id).toBe(empty.id);
  });
});
