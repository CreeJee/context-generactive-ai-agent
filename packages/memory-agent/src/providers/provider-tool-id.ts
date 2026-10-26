import { Schema } from "effect";

/**
 * The provider tool kinds and their `<provider>:<kind>` ids, apart from the tool factories so that
 * code bundled without the provider packages (the model requests) can name a tool.
 */

export const OpenAIProviderToolKind = Schema.Literals([
  "web_search",
  "web_search_preview",
  "file_search",
  "image_generation",
  "code_interpreter",
  "mcp",
  "computer_use",
  "local_shell",
  "shell",
  "apply_patch",
  "custom",
]);
export type OpenAIProviderToolKind = typeof OpenAIProviderToolKind.Type;
export const AnthropicProviderToolKind = Schema.Literals([
  "web_search",
  "web_fetch",
  "code_execution",
  "computer_use",
  "bash",
  "text_editor",
  "memory",
]);
export type AnthropicProviderToolKind = typeof AnthropicProviderToolKind.Type;
export type ProviderToolKind = OpenAIProviderToolKind | AnthropicProviderToolKind;
export const ProviderToolId = Schema.Union([
  Schema.TemplateLiteral(["openai:", OpenAIProviderToolKind]),
  Schema.TemplateLiteral(["anthropic:", AnthropicProviderToolKind]),
]);
export type ProviderToolId = typeof ProviderToolId.Type;
