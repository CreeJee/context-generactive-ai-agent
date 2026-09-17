import { convertSchemaToJsonSchema, normalizeSystemPrompts, type TextOptions } from "@tanstack/ai";

/**
 * Build the reusable part of a Codex request separately from history and turn input.
 * Prompt order carries meaning: callers put standing rules first and changing context last.
 * Only tool order is normalized; schemas and instruction text are preserved verbatim.
 * This makes our payload stable, not a guarantee of a provider cache hit.
 */
export function codexRequestPrefix(
  options: Pick<TextOptions<Record<string, never>>, "systemPrompts" | "tools">,
) {
  const instructions = normalizeSystemPrompts(options.systemPrompts ?? []).map(
    (prompt) => prompt.content,
  );
  const dynamicTools = [...(options.tools ?? [])]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      deferLoading: false,
      inputSchema: convertSchemaToJsonSchema(tool.inputSchema) ?? {
        type: "object",
        properties: {},
      },
    }));
  return {
    baseInstructions:
      instructions.length > 0 ? instructions.join("\n\n") : "You are a helpful assistant.",
    dynamicTools,
  };
}
