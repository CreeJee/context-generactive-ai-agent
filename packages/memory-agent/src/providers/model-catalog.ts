import { Schema } from "effect";

/**
 * The provider models this app knows, in the order @tanstack/ai-anthropic and @tanstack/ai-openai
 * 1.0.0 listed them. The app owns the lists so the provider packages can go
 * (docs/effect-ai-migration.md step 2); a model a provider adds is added here.
 */

export const AnthropicChatModel = Schema.Literals([
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-5",
]);
export type AnthropicChatModel = typeof AnthropicChatModel.Type;
export const ANTHROPIC_MODELS = AnthropicChatModel.literals;

export const OpenAIChatModel = Schema.Literals([
  "gpt-6.1-sol",
  "gpt-6.1-sol-pro",
  "gpt-6-luna",
  "gpt-6-luna-pro",
  "gpt-6-sol",
  "gpt-6-sol-pro",
  "gpt-6-astra",
  "gpt-6-astra-pro",
  "gpt-5.6-luna-pro",
  "gpt-5.6-sol-pro",
  "gpt-5.6-terra-pro",
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5.2-chat-latest",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5-codex",
  "o3",
  "o3-pro",
  "o3-mini",
  "o4-mini",
  "o3-deep-research",
  "o4-mini-deep-research",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4",
  "gpt-4-turbo",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-3.5-turbo",
  "gpt-audio",
  "gpt-audio-mini",
  "gpt-5.1-chat-latest",
  "gpt-5-chat-latest",
  "gpt-5.1-codex-mini",
  "gpt-4o-search-preview",
  "gpt-4o-mini-search-preview",
  "o1",
  "o1-pro",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-image-2",
  "gpt-chat-latest",
]);
export type OpenAIChatModel = typeof OpenAIChatModel.Type;
export const OPENAI_CHAT_MODELS = OpenAIChatModel.literals;

export const OpenAIImageModel = Schema.Literals([
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2",
  "gpt-image-1",
  "gpt-image-1-mini",
]);
export type OpenAIImageModel = typeof OpenAIImageModel.Type;
export const OPENAI_IMAGE_MODELS = OpenAIImageModel.literals;
