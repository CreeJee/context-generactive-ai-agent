import { chat, toolDefinition } from "@tanstack/ai";
import { Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { Nodes } from "../src/memory/nodes.ts";
import { makeRecordingMiddleware, Recorder } from "../src/memory/record.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { toToolSchema } from "../src/tools/schema.ts";
import { testRuntime } from "./support/runtime.ts";

const secret = `${"gh"}p_${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"}`;

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    /* consume actual SDK hooks */
  }
}

test("native recording factories isolate reused call IDs and defer user binding on central services", async () => {
  const { runtime, project, session } = await testRuntime();
  const nodes = await runtime.runPromise(Nodes);
  const reviews = await runtime.runPromise(PermissionReviews);
  const sessions = await runtime.runPromise(Sessions);
  const second = await runtime.runPromise(sessions.create(project.id));
  expect((await runtime.runPromise(Recorder)).factory).toBe(makeRecordingMiddleware);

  const executions = [
    { session, runId: "failed-run", fail: true, decision: "denied" as const },
    { session: second, runId: "successful-run", fail: false, decision: "approved" as const },
  ];
  await Promise.all(
    executions.map(async (entry) => {
      const user = nodes.append({
        projectId: project.id,
        sessionId: entry.session.id,
        kind: "user",
        text: "test",
      });
      let reads = 0;
      let currentUserId = "not-yet-bound";
      const middleware = await runtime.runPromise(
        makeRecordingMiddleware({
          projectId: project.id,
          sessionId: entry.session.id,
          runId: entry.runId,
          get userNodeId() {
            reads++;
            return currentUserId;
          },
        }),
      );
      expect(reads).toBe(0);
      currentUserId = user.id;
      reviews.record({
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
      await drain(
        chat({
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
      const stored = nodes.session(entry.session.id);
      const result = nodes.toolNode(entry.session.id, "tool_result", "shared-call");
      expect(result).toMatchObject({
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
        expect(nodes.edgesOf(assistant.id)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "reply", fromId: assistant.id, toId: user.id }),
          ]),
        );
      }
    }),
  );
});

test("one unbound factory reference uses each runtime's current native owner context", async () => {
  const first = await testRuntime();
  const second = await testRuntime();
  const factory = (await first.runtime.runPromise(Recorder)).factory;
  for (const owner of [first, second]) {
    const nodes = await owner.runtime.runPromise(Nodes);
    const user = nodes.append({
      projectId: owner.project.id,
      sessionId: owner.session.id,
      kind: "user",
      text: "hello",
    });
    const middleware = await owner.runtime.runPromise(
      factory({
        projectId: owner.project.id,
        sessionId: owner.session.id,
        runId: "same-run",
        userNodeId: user.id,
      }),
    );
    await drain(
      chat({
        adapter: new ScriptedTextAdapter([{ text: "owner answer" }]),
        messages: [{ role: "user", content: "hello" }],
        middleware: [middleware],
      }),
    );
    expect(nodes.session(owner.session.id).map((node) => node.text)).toEqual([
      "hello",
      "owner answer",
    ]);
  }
  const firstNodes = await first.runtime.runPromise(Nodes);
  expect(firstNodes.session(second.session.id)).toEqual([]);
});
