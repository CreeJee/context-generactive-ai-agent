import { chat, toolDefinition } from "@tanstack/ai";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { parallelReads } from "../src/tools/parallel-reads.ts";
import { toToolSchema } from "../src/tools/schema.ts";

const PathInput = toToolSchema(Schema.Struct({ path: Schema.String }));

/** A gate that opens once `count` callers wait at it, proving they ran at the same time. */
function barrier(count: number) {
  let waiting = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return () => {
    waiting++;
    if (waiting === count) open();
    return opened;
  };
}

describe("parallel read-only tool calls", () => {
  test("reads of one step run at once and answer in call order; a read after a write waits", async () => {
    const events: string[] = [];
    const gate = barrier(2);
    const tools = [
      toolDefinition({ name: "read_file", description: "read", inputSchema: PathInput }).server(
        async ({ path }) => {
          events.push(`start ${path}`);
          if (path !== "after-write") await gate();
          events.push(`end ${path}`);
          return `content of ${path}`;
        },
      ),
      toolDefinition({ name: "write_file", description: "write", inputSchema: PathInput }).server(
        async ({ path }) => {
          events.push(`write ${path}`);
          return "written";
        },
      ),
    ];
    const controller = new AbortController();
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
    await chat({
      adapter,
      messages: [{ role: "user", content: "go" }],
      tools: reads.tools,
      middleware: [reads.middleware],
      abortController: controller,
      stream: false,
    });

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
  });
});
