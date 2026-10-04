import type { MetadataStore, ModelMessage } from "@tanstack/ai";
import { expect, test } from "vite-plus/test";
import { handoffEvidenceContext, modelHandoffHistory } from "../src/agent/model-handoff.ts";
import type { Node } from "../src/memory/nodes.ts";

function fixture(stored: readonly ModelMessage[]) {
  const values = new Map<string, unknown>();
  const metadata: MetadataStore = {
    get: async (namespace, key) => values.get(`${namespace}:${key}`) ?? null,
    set: async (namespace, key, value) => {
      values.set(`${namespace}:${key}`, value);
    },
    delete: async (namespace, key) => {
      values.delete(`${namespace}:${key}`);
    },
  };
  const restore = (target: string, model: string, history = stored) =>
    modelHandoffHistory({
      metadata,
      threadId: "session",
      target,
      model,
      provider: "openai-compatible",
      loadHistory: async () => history,
      evidenceContext: async () => "Evidence summary (node observed-result)",
    });
  return { restore };
}

const oldCall = {
  id: "old-call",
  type: "function" as const,
  function: { name: "run_shell", arguments: '{"command":"build"}' },
};
const past: ModelMessage[] = [
  { role: "user", content: "프로젝트를 빌드해 줘" },
  {
    role: "assistant",
    content: null,
    thinking: [{ content: "private reasoning" }],
    toolCalls: [oldCall],
    metadata: { tanstack: { model: "old-model" } },
  },
  { role: "tool", toolCallId: "old-call", content: "build completed" },
];

test("a new model gets evidence context and real user questions, not the old protocol", async () => {
  const f = fixture(past);
  const input = [...past, { role: "user" as const, content: "이어서해줘" }];
  const original = structuredClone(input);
  const restored = await f.restore("provider:new-model", "new-model")(input);
  expect(restored).toEqual([
    { role: "assistant", content: "Evidence summary (node observed-result)" },
    past[0],
    input.at(-1),
  ]);
  expect(input).toEqual(original);
});

test("a retry/restart keeps the checkpoint and new-model tool iterations", async () => {
  const f = fixture(past);
  const question: ModelMessage = { role: "user", content: "continue" };
  const first = [...past, question];
  const restored = await f.restore("new", "new-model")(first);
  const newCall = { ...oldCall, id: "new-call" };
  const tail: ModelMessage[] = [
    question,
    { role: "assistant", content: null, toolCalls: [newCall] },
    { role: "tool", toolCallId: "new-call", content: "new result" },
  ];
  const retried = await f.restore("new", "new-model", [...past, ...tail])([...past, ...tail]);
  expect(retried?.slice(0, 2)).toEqual(restored?.slice(0, 2));
  expect(retried?.slice(2)).toEqual(tail);
});

test("same target preserves history; switching endpoints with the same model restores context", async () => {
  const f = fixture(past);
  expect(await f.restore("endpoint-a", "old-model")(past)).toBeNull();
  expect(await f.restore("endpoint-a", "old-model")(past)).toBeNull();
  expect(await f.restore("endpoint-b", "old-model")(past)).toEqual([
    { role: "assistant", content: "Evidence summary (node observed-result)" },
    past[0],
  ]);
});

test("pairs an approved old call completed during the new run without replaying other calls", async () => {
  const pending = past.slice(0, 2);
  const f = fixture(pending);
  const result = past[2]!;
  const restored = await f.restore("new", "new-model")([...pending, result]);
  expect(restored).toEqual([
    { role: "assistant", content: "Evidence summary (node observed-result)" },
    past[0],
    { role: "assistant", content: null, toolCalls: [oldCall] },
    result,
  ]);
});

test("rejects an invalidated boundary instead of dropping unrelated history", async () => {
  const f = fixture(past);
  await f.restore("new", "new-model")(past);
  await expect(
    f.restore(
      "new",
      "new-model",
    )([past[0]!, past[1]!, { role: "tool", content: "different result" }]),
  ).rejects.toThrow("saved boundary");
});

test("does not invent a user request for an assistant-only legacy thread", async () => {
  const history = past.slice(1);
  const f = fixture(history);
  await expect(f.restore("new", "new-model")(history)).rejects.toThrow("actual user question");
});

test("handoff context stays small and directs the model to retrieve evidence", () => {
  const nodes: Node[] = Array.from({ length: 100 }, (_, seq) => ({
    seq,
    id: `evidence-${seq}`,
    projectId: "project",
    sessionId: "session",
    runId: null,
    kind: "tool_result",
    text: "Recorded output ".repeat(1000),
    detail: { ok: seq !== 99 },
    createdAt: "2026-10-05T00:00:00Z",
  }));
  const context = handoffEvidenceContext(
    [{ end: 4, nextTurnNodeId: "next", text: "Verified summary (node evidence-1)" }],
    nodes,
  );
  expect(context.length).toBeLessThan(8000);
  expect(context).toContain("Verified summary (node evidence-1)");
  expect(context).toContain("node evidence-99 failed");
  expect(context).not.toContain("node evidence-0]");
  expect(context).toContain("find_memory");
  expect(context).toContain("read_evidence");
  expect(context).toContain("currently available skills");
  expect(context).not.toContain(nodes[99]!.text);
});
