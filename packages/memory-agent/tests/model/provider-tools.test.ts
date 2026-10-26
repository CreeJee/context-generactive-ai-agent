import { it } from "@effect/vitest";
import * as AnthropicTools from "@tanstack/ai-anthropic/tools";
import * as OpenAITools from "@tanstack/ai-openai/tools";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import type { ProviderToolConfig } from "../../src/providers/provider-tools.ts";
import { providerTools } from "../../src/providers/provider-tools.ts";
import { toolRequestDifferences } from "../support/requests.ts";

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
 * Each provider tool as TanStack's factory made it and with the configuration it was given, one
 * list per vendor: their tool names overlap.
 */
const openAICases = [
  [OpenAITools.webSearchTool(webSearch), providerTools["openai:web_search"](webSearch)],
  [
    OpenAITools.webSearchPreviewTool({ type: "web_search_preview" }),
    providerTools["openai:web_search_preview"]({ type: "web_search_preview" }),
  ],
  [OpenAITools.fileSearchTool(fileSearch), providerTools["openai:file_search"](fileSearch)],
  [OpenAITools.imageGenerationTool({}), providerTools["openai:image_generation"]({})],
  [
    OpenAITools.codeInterpreterTool(interpreter),
    providerTools["openai:code_interpreter"](interpreter),
  ],
  [OpenAITools.mcpTool(mcp), providerTools["openai:mcp"](mcp)],
  [OpenAITools.computerUseTool(computer), providerTools["openai:computer_use"](computer)],
  [OpenAITools.localShellTool(), providerTools["openai:local_shell"]({})],
  [OpenAITools.shellTool(), providerTools["openai:shell"]({})],
  [OpenAITools.applyPatchTool(), providerTools["openai:apply_patch"]({})],
  [OpenAITools.customTool(custom), providerTools["openai:custom"](custom)],
] as const;
const anthropicCases = [
  [
    AnthropicTools.webSearchTool(anthropicSearch),
    providerTools["anthropic:web_search"](anthropicSearch),
  ],
  [AnthropicTools.webFetchTool(), providerTools["anthropic:web_fetch"]({})],
  [
    AnthropicTools.codeExecutionTool(codeExecution),
    providerTools["anthropic:code_execution"](codeExecution),
  ],
  [
    AnthropicTools.computerUseTool(anthropicComputer),
    providerTools["anthropic:computer_use"](anthropicComputer),
  ],
  [AnthropicTools.bashTool(bash), providerTools["anthropic:bash"](bash)],
  [AnthropicTools.textEditorTool(textEditor), providerTools["anthropic:text_editor"](textEditor)],
  [AnthropicTools.memoryTool(), providerTools["anthropic:memory"]({})],
] as const;

// A description taken from the configuration falls back without it.
const bare = { type: "mcp", server_label: "docs", server_url: mcp.server_url } as const;
const unnamed: ProviderToolConfig = { type: "custom", name: "grammar" };
const fallbackCases = [
  [OpenAITools.mcpTool(bare), providerTools["openai:mcp"](bare)],
  [
    OpenAITools.customTool({ type: "custom", name: "grammar" }),
    providerTools["openai:custom"](unnamed),
  ],
] as const;

describe("provider tools", () => {
  it.effect("reach the subscription endpoints as TanStack sent them", () =>
    Effect.gen(function* () {
      expect(openAICases.length + anthropicCases.length).toBe(Object.keys(providerTools).length);
      // A vendor's tools at once, so their order is compared too.
      for (const cases of [openAICases, anthropicCases, fallbackCases])
        expect(
          yield* toolRequestDifferences({
            chatTools: cases.map(([tanstack]) => tanstack),
            modelTools: cases.map(([, tool]) => tool),
          }),
        ).toStrictEqual([
          { provider: "anthropic", difference: undefined },
          { provider: "openai", difference: undefined },
        ]);
    }),
  );
});
