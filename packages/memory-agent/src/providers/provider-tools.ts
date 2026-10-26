import { Option, Predicate, Record, Schema } from "effect";
import { Tool } from "effect/ai";
import { JsonValue } from "../json.ts";
import { ProviderToolId } from "./tool-capabilities.ts";

/**
 * The 18 provider tools of `tool-capabilities.ts` as Effect AI provider-defined tools, named and
 * described as the TanStack factories made them (docs/effect-ai-migration.md step 2). A tool's
 * args are the provider's configuration as given; `tool-policy.ts` checks them before a tool is
 * made.
 */

/** A provider tool's configuration, sent to the provider as given. */
export const ProviderToolConfig = Schema.Record(Schema.String, JsonValue);
export type ProviderToolConfig = typeof ProviderToolConfig.Type;

interface Definition {
  /** The tool's name, which TanStack also sent as its function name. */
  readonly name: string;
  readonly description: string;
  /** The configuration key whose text, when set, replaces `name` in what TanStack sent. */
  readonly namedBy?: string;
  /** The configuration key whose text, when set, replaces `description`. */
  readonly describedBy?: string;
}

const definitions = {
  "openai:web_search": { name: "web_search", description: "Search the web" },
  "openai:web_search_preview": {
    name: "web_search_preview",
    description: "Search the web (preview version)",
  },
  "openai:file_search": { name: "file_search", description: "Search files in vector stores" },
  "openai:image_generation": {
    name: "image_generation",
    description: "Generate images based on text descriptions",
  },
  "openai:code_interpreter": {
    name: "code_interpreter",
    description: "Execute code in a sandboxed environment",
  },
  "openai:mcp": { name: "mcp", description: "", describedBy: "server_description" },
  // `tool-policy.ts` accepts only this type; TanStack named the tool after the type it was given.
  "openai:computer_use": {
    name: "computer_use_preview",
    description: "Control a virtual computer",
    namedBy: "type",
  },
  "openai:local_shell": { name: "local_shell", description: "Execute local shell commands" },
  "openai:shell": { name: "shell", description: "Execute shell commands" },
  "openai:apply_patch": { name: "apply_patch", description: "Apply a patch to modify files" },
  "openai:custom": { name: "custom", description: "A custom tool", describedBy: "description" },
  "anthropic:web_search": { name: "web_search", description: "" },
  "anthropic:web_fetch": { name: "web_fetch", description: "" },
  "anthropic:code_execution": { name: "code_execution", description: "" },
  "anthropic:computer_use": { name: "computer", description: "" },
  "anthropic:bash": { name: "bash", description: "" },
  "anthropic:text_editor": { name: "str_replace_editor", description: "" },
  "anthropic:memory": { name: "memory", description: "" },
} as const satisfies Record<ProviderToolId, Definition>;

/** The Effect AI id of a provider tool, the kind TanStack branded it with: `openai.web_search`. */
const effectId = (id: ProviderToolId) => {
  const at = id.indexOf(":");
  return `${id.slice(0, at)}.${id.slice(at + 1)}` as const;
};

/** Makes the provider tool `id` with its configuration. */
export const providerTools = Record.map(definitions, (definition: Definition, id: ProviderToolId) =>
  Tool.providerDefined({
    id: effectId(id),
    customName: definition.name,
    providerName: definition.name,
    args: ProviderToolConfig,
  }),
);

const decodeId = Schema.decodeUnknownOption(ProviderToolId);
const decodeConfig = Schema.decodeUnknownOption(ProviderToolConfig);

/** The text under `key` of a tool's configuration, or `fallback` when there is none. */
const configText = (
  config: Option.Option<ProviderToolConfig>,
  key: string | undefined,
  fallback: string,
) =>
  Option.getOrElse(
    Option.fromNullishOr(key).pipe(
      Option.flatMap((name) =>
        Option.flatMap(config, (values) => Option.fromNullishOr(values[name])),
      ),
      Option.filter(Predicate.isString),
      Option.filter((text) => text !== ""),
    ),
    () => fallback,
  );

/**
 * The function tool TanStack sent the subscription endpoints for a provider tool: its name, its
 * description and no parameters. None for a tool that is not one of the 18.
 */
export const providerToolFunction = (tool: Tool.Any) =>
  Tool.isProviderDefined(tool)
    ? Option.map(decodeId(tool.id.replace(".", ":")), (id) => {
        const definition: Definition = definitions[id];
        const config = decodeConfig(tool.args);
        return {
          name: configText(config, definition.namedBy, definition.name),
          description: configText(config, definition.describedBy, definition.description),
          input_schema: { type: "object", properties: {} },
        };
      })
    : Option.none();
