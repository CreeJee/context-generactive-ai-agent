import { it } from "@effect/vitest";
import { chat, toolDefinition } from "@tanstack/ai";
import { Deferred, Effect, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { sdkPromiseWithController } from "../src/runtime/sdk-promise.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { parallelReads } from "../src/tools/parallel-reads.ts";
import { toToolSchema } from "../src/tools/schema.ts";
import { sdkCancellation } from "./support/sdk-cancellation.ts";

const PathInput = toToolSchema(Schema.Struct({ path: Schema.String }));

/** A gate that opens once `count` callers wait at it, proving they ran at the same time. */
const barrier = Effect.fnUntraced(function* (count: number) {
  let waiting = 0;
  const opened = yield* Deferred.make<void>();
  return {
    await: Effect.gen(function* () {
      waiting++;
      if (waiting === count) yield* Deferred.succeed(opened, undefined);
      yield* Deferred.await(opened);
    }),
  };
});

describe("parallel read-only tool calls", () => {
  it.effect(
    "reads of one step run at once and answer in call order; a read after a write waits",
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const gate = yield* barrier(2);
        const run = Effect.runPromiseWith(yield* Effect.context());
        const tools = [
          toolDefinition({ name: "read_file", description: "read", inputSchema: PathInput }).server(
            ({ path }) =>
              run(
                Effect.gen(function* () {
                  events.push(`start ${path}`);
                  if (path !== "after-write") yield* gate.await;
                  events.push(`end ${path}`);
                  return `content of ${path}`;
                }),
              ),
          ),
          toolDefinition({
            name: "write_file",
            description: "write",
            inputSchema: PathInput,
          }).server(({ path }) => {
            events.push(`write ${path}`);
            return "written";
          }),
        ];
        const { controller } = yield* sdkCancellation;
        const reads = parallelReads(tools, controller.signal);
        const adapter = new ScriptedTextAdapter([
          {
            toolCalls: [
              { id: "r1", name: "read_file", arguments: '{"path":"a"}' },
              { id: "r2", name: "read_file", arguments: '{"path":"b"}' },
              { id: "w1", name: "write_file", arguments: '{"path":"c"}' },
              { id: "r3", name: "read_file", arguments: '{"path":"after-write"}' },
            ],
          },
          { text: "done" },
        ]);

        // Without early starts, the first read would wait at the barrier forever.
        yield* sdkPromiseWithController(
          () =>
            chat({
              adapter,
              messages: [{ role: "user", content: "go" }],
              tools: reads.tools,
              middleware: [reads.middleware],
              abortController: controller,
              stream: false,
            }),
          controller,
        );

        expect(events.slice(0, 2).toSorted()).toEqual(["start a", "start b"]);
        expect(events.indexOf("write c")).toBeLessThan(events.indexOf("start after-write"));
        const results = adapter.invocations[1]!.messages.flatMap((message) =>
          message.role === "tool" ? [[message.toolCallId, message.content]] : [],
        );
        expect(results).toEqual([
          ["r1", "content of a"],
          ["r2", "content of b"],
          ["w1", "written"],
          ["r3", "content of after-write"],
        ]);
      }),
  );
});
