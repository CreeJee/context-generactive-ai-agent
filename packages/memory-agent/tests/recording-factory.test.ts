import { Cause } from "effect";
import { it } from "@effect/vitest";
import { chat, toolDefinition } from "@tanstack/ai";
import { Effect, Schema, Stream } from "effect";
import { expect } from "vite-plus/test";
import { Nodes } from "../src/memory/nodes.ts";
import { makeRecordingMiddleware, Recorder } from "../src/memory/record.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { toToolSchema } from "../src/tools/schema.ts";
import { testRuntime } from "./support/runtime.ts";

const secret = `${"gh"}p_${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"}`;

const drain = (stream: AsyncIterable<unknown>) =>
  Stream.runDrain(Stream.fromAsyncIterable(stream, (cause) => new Cause.UnknownError(cause)));

it.live(
  "native recording factories isolate reused call IDs and defer user binding on central services",
  () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* Effect.promise(() => testRuntime());
      const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
      const reviews = yield* Effect.provideContext(PermissionReviews, yield* runtime.contextEffect);
      const sessions = yield* Effect.provideContext(Sessions, yield* runtime.contextEffect);
      const second = yield* Effect.provideContext(
        sessions.create(project.id),
        yield* runtime.contextEffect,
      );
      expect((yield* Effect.provideContext(Recorder, yield* runtime.contextEffect)).factory).toBe(
        makeRecordingMiddleware,
      );

      const executions = [
        { session, runId: "failed-run", fail: true, decision: "denied" as const },
        { session: second, runId: "successful-run", fail: false, decision: "approved" as const },
      ];
      yield* Effect.forEach(
        executions,
        (entry) =>
          Effect.gen(function* () {
            const user = nodes.append({
              projectId: project.id,
              sessionId: entry.session.id,
              kind: "user",
              text: "test",
            });
            let reads = 0;
            let currentUserId = "not-yet-bound";
            const middleware = yield* Effect.provideContext(
              makeRecordingMiddleware({
                projectId: project.id,
                sessionId: entry.session.id,
                runId: entry.runId,
                get userNodeId() {
                  reads++;
                  return currentUserId;
                },
              }),
              yield* runtime.contextEffect,
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
            yield* drain(
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
        { concurrency: "unbounded" },
      );
    }),
);

it.live("one unbound factory reference uses each runtime's current native owner context", () =>
  Effect.gen(function* () {
    const first = yield* Effect.promise(() => testRuntime());
    const second = yield* Effect.promise(() => testRuntime());
    const factory = (yield* Effect.provideContext(Recorder, yield* first.runtime.contextEffect))
      .factory;
    for (const owner of [first, second]) {
      const nodes = yield* Effect.provideContext(Nodes, yield* owner.runtime.contextEffect);
      const user = nodes.append({
        projectId: owner.project.id,
        sessionId: owner.session.id,
        kind: "user",
        text: "hello",
      });
      const middleware = yield* Effect.provideContext(
        factory({
          projectId: owner.project.id,
          sessionId: owner.session.id,
          runId: "same-run",
          userNodeId: user.id,
        }),
        yield* owner.runtime.contextEffect,
      );
      yield* drain(
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
    const firstNodes = yield* Effect.provideContext(Nodes, yield* first.runtime.contextEffect);
    expect(firstNodes.session(second.session.id)).toEqual([]);
  }),
);
