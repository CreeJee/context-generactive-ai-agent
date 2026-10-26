import { Option, Predicate, Record, Schema } from "effect";
import { Tool } from "effect/ai";
import { JsonValue } from "../json.ts";
import { ProviderToolId } from "./provider-tool-id.ts";

/**
 * The 18 provider tools of `tool-capabilities.ts` as Effect AI provider-defined tools, named and
 * described as the TanStack factories made them (docs/effect-ai-migration.md step 2). A tool's
 * args are the provider's configuration as given, once `acceptsConfig` has checked it.
 */

/** A provider tool's configuration, sent to the provider as given. */
export const ProviderToolConfig = Schema.Record(Schema.String, JsonValue);
export type ProviderToolConfig = typeof ProviderToolConfig.Type;

/** What a tool's configuration may hold: only these keys, and a `type` the check accepts. */
interface ConfigRule {
  readonly keys: ReadonlyArray<string>;
  readonly type: (type: JsonValue | undefined) => boolean;
  /** An empty configuration stands for none, which the tool can go without. */
  readonly optional: boolean;
}

type TypeCheck = ConfigRule["type"];
const anyType: TypeCheck = () => true;
const exactly =
  (text: string): TypeCheck =>
  (type) =>
    type === text;
/** A dated type such as `bash_20250124`. */
const versionOf =
  (prefix: string): TypeCheck =>
  (type) =>
    Predicate.isString(type) && type.startsWith(`${prefix}_`);
const required = (keys: ReadonlyArray<string>, type = anyType): ConfigRule => ({
  keys,
  type,
  optional: false,
});
const optional = (keys: ReadonlyArray<string>, type = anyType): ConfigRule => ({
  keys,
  type,
  optional: true,
});
const none = optional([]);

interface Definition {
  /** The tool's name, which TanStack also sent as its function name. */
  readonly name: string;
  readonly description: string;
  /** The configuration key whose text, when set, replaces `name` in what TanStack sent. */
  readonly namedBy?: string;
  /** The configuration key whose text, when set, replaces `description`. */
  readonly describedBy?: string;
  readonly config: ConfigRule;
}

const openAIWebKeys = [
  "type",
  "external_web_access",
  "filters",
  "search_context_size",
  "user_location",
];

const definitions = {
  "openai:web_search": {
    name: "web_search",
    description: "Search the web",
    config: required(openAIWebKeys, exactly("web_search")),
  },
  "openai:web_search_preview": {
    name: "web_search_preview",
    description: "Search the web (preview version)",
    config: required(
      ["type", "search_context_size", "user_location"],
      exactly("web_search_preview"),
    ),
  },
  "openai:file_search": {
    name: "file_search",
    description: "Search files in vector stores",
    config: required(
      ["type", "vector_store_ids", "filters", "max_num_results", "ranking_options"],
      exactly("file_search"),
    ),
  },
  "openai:image_generation": {
    name: "image_generation",
    description: "Generate images based on text descriptions",
    config: required([
      "action",
      "background",
      "input_fidelity",
      "input_image_mask",
      "model",
      "moderation",
      "output_compression",
      "output_format",
      "partial_images",
      "quality",
      "size",
    ]),
  },
  "openai:code_interpreter": {
    name: "code_interpreter",
    description: "Execute code in a sandboxed environment",
    config: required(["type", "container"], exactly("code_interpreter")),
  },
  "openai:mcp": {
    name: "mcp",
    description: "",
    describedBy: "server_description",
    config: required(
      [
        "type",
        "server_label",
        "server_url",
        "connector_id",
        "authorization",
        "headers",
        "allowed_tools",
        "require_approval",
        "server_description",
      ],
      exactly("mcp"),
    ),
  },
  // Only this type is accepted; TanStack named the tool after the type it was given.
  "openai:computer_use": {
    name: "computer_use_preview",
    description: "Control a virtual computer",
    namedBy: "type",
    config: required(
      ["type", "display_width", "display_height", "environment"],
      exactly("computer_use_preview"),
    ),
  },
  "openai:local_shell": {
    name: "local_shell",
    description: "Execute local shell commands",
    config: none,
  },
  "openai:shell": {
    name: "shell",
    description: "Execute shell commands",
    config: optional(["type", "environment"], exactly("shell")),
  },
  "openai:apply_patch": {
    name: "apply_patch",
    description: "Apply a patch to modify files",
    config: none,
  },
  "openai:custom": {
    name: "custom",
    description: "A custom tool",
    describedBy: "description",
    config: required(
      ["type", "name", "allowed_callers", "defer_loading", "description", "format"],
      exactly("custom"),
    ),
  },
  "anthropic:web_search": {
    name: "web_search",
    description: "",
    config: required(
      ["type", "name", "max_uses", "allowed_domains", "blocked_domains", "user_location"],
      versionOf("web_search"),
    ),
  },
  "anthropic:web_fetch": {
    name: "web_fetch",
    description: "",
    config: optional(
      [
        "type",
        "name",
        "max_uses",
        "allowed_domains",
        "blocked_domains",
        "citations",
        "max_content_tokens",
      ],
      exactly("web_fetch_20250910"),
    ),
  },
  "anthropic:code_execution": {
    name: "code_execution",
    description: "",
    config: required(["type", "name"], versionOf("code_execution")),
  },
  "anthropic:computer_use": {
    name: "computer",
    description: "",
    config: required(
      ["type", "name", "display_width_px", "display_height_px", "display_number", "enable_zoom"],
      versionOf("computer"),
    ),
  },
  "anthropic:bash": {
    name: "bash",
    description: "",
    config: required(["type", "name"], versionOf("bash")),
  },
  "anthropic:text_editor": {
    name: "str_replace_editor",
    description: "",
    config: required(["type", "name", "max_characters"], versionOf("text_editor")),
  },
  "anthropic:memory": {
    name: "memory",
    description: "",
    config: optional(["type", "name"], exactly("memory_20250818")),
  },
} as const satisfies Record<ProviderToolId, Definition>;

/** Whether `config` is one the provider tool `id` takes: known keys and a valid `type`. */
export const acceptsConfig = ({
  id,
  config,
}: {
  readonly id: ProviderToolId;
  readonly config: ProviderToolConfig;
}) => {
  const rule: ConfigRule = definitions[id].config;
  const keys = Object.keys(config);
  return (
    (rule.optional && keys.length === 0) ||
    (keys.every((key) => rule.keys.includes(key)) && rule.type(config["type"]))
  );
};

/** The configuration as TanStack's factory took it, which had no argument for none. */
export const factoryArguments = ({
  id,
  config,
}: {
  readonly id: ProviderToolId;
  readonly config: ProviderToolConfig;
}): ReadonlyArray<ProviderToolConfig> =>
  definitions[id].config.optional && Object.keys(config).length === 0 ? [] : [config];

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
