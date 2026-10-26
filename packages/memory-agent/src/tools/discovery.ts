import {
  Array as Arr,
  Data,
  Effect,
  type JsonSchema,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";
import type { StoredMessage } from "../chat-store/schema.ts";
import type { JsonValue } from "../json.ts";
import { toolParameters } from "../model/tool-schema.ts";
import { optionalProperty } from "../optional-property.ts";
import { runTool, type RunTool } from "./run-tool.ts";

/**
 * Lazy tools as TanStack's `LazyToolManager` kept them (docs/effect-ai-migration.md step 3). A
 * request lists a lazy tool by name only, in the discovery tool's description, until the model
 * asks for it; from then on, in this run or a later one of the conversation, it is offered in full.
 */

/** The discovery tool's name, which stored conversations call it by. */
export const discoveryToolName = "__lazy__tool__discovery__";

const DiscoveryInput = Schema.Struct({ toolNames: Schema.Array(Schema.String) });

/** The parameters as TanStack sent them, written in JSON Schema rather than built from one. */
const discoveryParameters = {
  type: "object",
  properties: {
    toolNames: {
      type: "array",
      items: { type: "string" },
      description:
        "List of tool names to discover. Each name must match one of the available tools.",
    },
  },
  required: ["toolNames"],
};

/** The part of a discovery call's stored result that says what it discovered. */
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  ),
);

/** The lazy tools a conversation discovered, in the order it did. */
const discoveredIn = (history: ReadonlyArray<StoredMessage>, lazy: ReadonlySet<string>) => {
  const calls = new Set(
    history.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? [])
            .filter((call) => call.function.name === discoveryToolName)
            .map((call) => call.id)
        : [],
    ),
  );
  return Arr.dedupe(
    history.flatMap((message) =>
      message.role === "tool" && calls.has(message.toolCallId)
        ? Option.match(
            decodeAnswer(
              Predicate.isString(message.content)
                ? message.content
                : JSON.stringify(message.content),
            ),
            {
              onNone: () => [],
              onSome: ({ tools }) =>
                tools.map((tool) => tool.name).filter((name) => lazy.has(name)),
            },
          )
        : [],
    ),
  );
};

/** What a call by name runs: a tool, an answer that the lazy tool is not discovered yet, or none. */
export type ToolLookup = Data.TaggedEnum<{
  Found: { readonly tool: RunTool };
  Undiscovered: { readonly answer: JsonValue };
  Unknown: {};
}>;
export const ToolLookup = Data.taggedEnum<ToolLookup>();

/** The run's tools with TanStack's lazy discovery, seeded with what `history` discovered. */
export const lazyToolsFor = Effect.fnUntraced(function* (
  tools: ReadonlyArray<RunTool>,
  history: ReadonlyArray<StoredMessage>,
) {
  const lazy = tools.filter((tool) => tool.lazy);
  const eager = tools.filter((tool) => !tool.lazy);
  const lazyByName = new Map(lazy.map((tool) => [tool.tool.name, tool] as const));
  const discovered = yield* Ref.make(discoveredIn(history, new Set(lazyByName.keys())));
  const undiscovered = (names: ReadonlyArray<string>) =>
    lazy.map((tool) => tool.tool.name).filter((name) => !names.includes(name));

  const discovery = runTool({
    name: discoveryToolName,
    description: `You have access to additional tools that can be discovered. Available tools: [${[...lazyByName.keys()].join(", ")}]. Call this tool with a list of tool names to discover their full descriptions and argument schemas before using them.`,
    parameters: DiscoveryInput,
    jsonSchema: discoveryParameters,
    handler: ({ toolNames }) =>
      Ref.modify(discovered, (before) => {
        let names = before;
        const found: Array<{
          readonly name: string;
          readonly description: string;
          readonly inputSchema: JsonSchema.JsonSchema;
        }> = [];
        const errors: Array<string> = [];
        for (const name of toolNames) {
          const tool = lazyByName.get(name);
          if (tool === undefined) {
            errors.push(
              `Unknown tool: '${name}'. Available tools: [${undiscovered(names).join(", ")}]`,
            );
            continue;
          }
          names = names.includes(name) ? names : [...names, name];
          found.push({
            name,
            description: tool.tool.description ?? "",
            inputSchema: toolParameters(tool.tool),
          });
        }
        const answer = {
          tools: found,
          ...optionalProperty("errors", errors.length > 0 ? errors : undefined),
        };
        return [answer, names] as const;
      }),
  });

  return {
    /** The tools a step offers: eager ones, discovered ones, and discovery while some remain. */
    offered: Effect.map(Ref.get(discovered), (names): ReadonlyArray<RunTool> => [
      ...eager,
      ...names.flatMap((name) => Option.toArray(Option.fromNullishOr(lazyByName.get(name)))),
      ...(lazy.length > names.length ? [discovery] : []),
    ]),

    /** The tool a call by `name` runs. Discovery stays callable after everything is found. */
    find: (name: string) =>
      Effect.map(Ref.get(discovered), (names): ToolLookup => {
        const tool = eager.find((candidate) => candidate.tool.name === name);
        if (tool !== undefined) return ToolLookup.Found({ tool });
        if (name === discoveryToolName && lazy.length > 0)
          return ToolLookup.Found({ tool: discovery });
        const lazyTool = lazyByName.get(name);
        if (lazyTool === undefined) return ToolLookup.Unknown();
        return names.includes(name)
          ? ToolLookup.Found({ tool: lazyTool })
          : ToolLookup.Undiscovered({
              answer: {
                error: `Error: Tool '${name}' must be discovered first. Call ${discoveryToolName} with toolNames: ['${name}'] to discover it.`,
              },
            });
      }),
  };
});
