import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import type { ProviderToolConfig } from "../../src/providers/provider-tools.ts";
import { providerTools } from "../../src/providers/provider-tools.ts";
import { matchGolden, subscriptionToolRequestBodies } from "../support/requests.ts";

/**
 * The subscription endpoints get each provider tool as the function tool TanStack sent for it
 * (docs/effect-ai-migration.md step 2), so a conversation that offers one keeps its request.
 */

const webSearch = { type: "web_search" } as const;
const fileSearch = { type: "file_search" as const, vector_store_ids: ["vs_1"] };
const interpreter = { type: "code_interpreter", container: { type: "auto" } } as const;
const mcp = {
  type: "mcp",
  server_label: "docs",
  server_url: "https://example.com/mcp",
  server_description: "Searches the docs",
} as const;
// TanStack names this tool after its type.
const computer = { type: "computer" } as const;
const custom = { type: "custom", name: "grammar", description: "Parses text" } as const;
const anthropicSearch = { type: "web_search_20250305", name: "web_search" } as const;
const codeExecution = { type: "code_execution_20250825", name: "code_execution" } as const;
const anthropicComputer = {
  type: "computer_20250124",
  name: "computer",
  display_width_px: 1024,
  display_height_px: 768,
} as const;
const bash = { type: "bash_20250124", name: "bash" } as const;
const textEditor = { type: "text_editor_20250728", name: "str_replace_based_edit_tool" } as const;

/**
 * Each provider tool with the configuration TanStack's factory was given for it, one list per
 * vendor: their tool names overlap.
 */
const openAICases = [
  providerTools["openai:web_search"](webSearch),
  providerTools["openai:web_search_preview"]({ type: "web_search_preview" }),
  providerTools["openai:file_search"](fileSearch),
  providerTools["openai:image_generation"]({}),
  providerTools["openai:code_interpreter"](interpreter),
  providerTools["openai:mcp"](mcp),
  providerTools["openai:computer_use"](computer),
  providerTools["openai:local_shell"]({}),
  providerTools["openai:shell"]({}),
  providerTools["openai:apply_patch"]({}),
  providerTools["openai:custom"](custom),
] as const;
const anthropicCases = [
  providerTools["anthropic:web_search"](anthropicSearch),
  providerTools["anthropic:web_fetch"]({}),
  providerTools["anthropic:code_execution"](codeExecution),
  providerTools["anthropic:computer_use"](anthropicComputer),
  providerTools["anthropic:bash"](bash),
  providerTools["anthropic:text_editor"](textEditor),
  providerTools["anthropic:memory"]({}),
] as const;

// A description taken from the configuration falls back without it.
const bare = { type: "mcp", server_label: "docs", server_url: mcp.server_url } as const;
const unnamed: ProviderToolConfig = { type: "custom", name: "grammar" };
const fallbackCases = [
  providerTools["openai:mcp"](bare),
  providerTools["openai:custom"](unnamed),
] as const;

describe("provider tools", () => {
  it.effect("reach the subscription endpoints as TanStack sent them", () => {
    expect(openAICases.length + anthropicCases.length).toBe(Object.keys(providerTools).length);
    // A vendor's tools at once, so their order is kept too.
    return matchGolden("./__golden__/provider-tools.json")(
      [openAICases, anthropicCases, fallbackCases].map(subscriptionToolRequestBodies),
    );
  });
});
