import { it } from "@effect/vitest";
import { toolDefinition } from "@tanstack/ai";
import { Effect, Schema } from "effect";
import { assert, describe, expect } from "vite-plus/test";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import { toolParameters } from "../../src/model/tool-schema.ts";
import { discoveryToolName, lazyToolsFor, ToolLookup } from "../../src/tools/discovery.ts";
import { lazily } from "../../src/tools/lazy.ts";
import { runTool, type RunTool } from "../../src/tools/run-tool.ts";
import { toToolSchema } from "../../src/tools/schema.ts";
import { compatibleToolRequestDifference, toolRequestDifferences } from "../support/requests.ts";

/**
 * Lazy tools are offered, discovered and refused as TanStack's lazy tool manager did
 * (docs/effect-ai-migration.md step 3).
 */

const PathInput = Schema.Struct({ path: Schema.String });
const definitions = [
  { name: "read_file", description: "Read a file.", parameters: PathInput, lazy: false },
  { name: "delete_file", description: "Delete a file.", parameters: PathInput, lazy: true },
  { name: "list_outside", description: "List outside.", parameters: PathInput, lazy: true },
];
const tools: ReadonlyArray<RunTool> = definitions.map((definition) =>
  runTool({ ...definition, handler: () => Effect.void }),
);
const chatTools = () =>
  definitions.map(({ name, description, parameters, lazy }) => {
    const tool = toolDefinition({ name, description, inputSchema: toToolSchema(parameters) });
    return lazy ? lazily(tool) : tool;
  });

const discover = (lazyTools: Effect.Success<ReturnType<typeof lazyToolsFor>>, names: string[]) =>
  Effect.gen(function* () {
    const found = yield* lazyTools.find(discoveryToolName);
    assert(ToolLookup.$is("Found")(found));
    const run = yield* found.tool.prepare({ toolNames: names });
    return yield* run({ toolCallId: "call-1" });
  });

const offeredNames = (lazyTools: Effect.Success<ReturnType<typeof lazyToolsFor>>) =>
  Effect.map(lazyTools.offered, (offered) => offered.map((tool) => tool.tool.name));

describe("lazy tools", () => {
  it.effect("offer what TanStack offered before anything is discovered", () =>
    Effect.gen(function* () {
      const lazyTools = yield* lazyToolsFor(tools, []);
      const modelTools = (yield* lazyTools.offered).map((tool) => tool.tool);
      expect(yield* toolRequestDifferences({ chatTools: chatTools(), modelTools })).toEqual([
        { provider: "anthropic", difference: undefined },
        { provider: "openai", difference: undefined },
      ]);
      expect(
        yield* compatibleToolRequestDifference({ chatTools: chatTools(), modelTools }),
      ).toBeUndefined();
    }),
  );

  it.effect("answer a discovery call and offer what it found from then on", () =>
    Effect.gen(function* () {
      const lazyTools = yield* lazyToolsFor(tools, []);
      expect(yield* lazyTools.find("delete_file")).toEqual(
        ToolLookup.Undiscovered({
          answer: {
            error: `Error: Tool 'delete_file' must be discovered first. Call ${discoveryToolName} with toolNames: ['delete_file'] to discover it.`,
          },
        }),
      );
      expect(yield* discover(lazyTools, ["delete_file", "nope"])).toEqual({
        tools: [
          {
            name: "delete_file",
            description: "Delete a file.",
            inputSchema: toolParameters(tools[1]!.tool),
          },
        ],
        errors: ["Unknown tool: 'nope'. Available tools: [list_outside]"],
      });
      expect(yield* offeredNames(lazyTools)).toEqual([
        "read_file",
        "delete_file",
        discoveryToolName,
      ]);
      yield* discover(lazyTools, ["list_outside"]);
      expect(yield* offeredNames(lazyTools)).toEqual(["read_file", "delete_file", "list_outside"]);
      expect(ToolLookup.$is("Found")(yield* lazyTools.find(discoveryToolName))).toBe(true);
    }),
  );

  it.effect("keep what the conversation discovered before", () =>
    Effect.gen(function* () {
      const history: ReadonlyArray<StoredMessage> = [
        { role: "user", content: "clean up" },
        {
          role: "assistant",
          toolCalls: [
            {
              id: "call-0",
              type: "function",
              function: { name: discoveryToolName, arguments: '{"toolNames":["list_outside"]}' },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-0",
          content: '{"tools":[{"name":"list_outside","description":""}]}',
        },
      ];
      const lazyTools = yield* lazyToolsFor(tools, history);
      expect(yield* offeredNames(lazyTools)).toEqual([
        "read_file",
        "list_outside",
        discoveryToolName,
      ]);
    }),
  );
});
