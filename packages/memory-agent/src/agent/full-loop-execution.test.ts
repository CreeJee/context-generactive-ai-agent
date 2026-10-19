import { describe, expect, it } from "@effect/vitest";
import type { AnyServerTool } from "@tanstack/ai";
import { webSearchTool } from "@tanstack/ai-openai/tools";
import { vi } from "vite-plus/test";
import { ScriptedTextAdapter } from "../testing/scripted-adapter.ts";
import { preflightFullLoopExecution } from "./full-loop-execution.ts";

describe("full-loop preflight", () => {
  it("rejects provider-native web search before any model call", () => {
    const adapter = new ScriptedTextAdapter([{ text: "not called" }]);
    const modelCall = vi.spyOn(adapter, "chatStream");
    const invalidInventory: AnyServerTool[] = [];
    // Meta API injects the official provider-native tool into an invalid server
    // inventory to prove rejection; this is not asserted to be a valid server tool.
    Reflect.set(invalidInventory, 0, webSearchTool({ type: "web_search" }));
    expect(() =>
      preflightFullLoopExecution(
        { messages: [], runId: "r", threadId: "s" },
        {
          model: { adapter },
          tools: invalidInventory,
          middleware: [],
          stream: { abortController: new AbortController() },
        },
      ),
    ).toThrow(
      expect.objectContaining({
        _tag: "FullLoopAdmissionRejected",
        reason: { _tag: "UnsupportedTool" },
      }),
    );
    expect(modelCall).not.toHaveBeenCalled();
  });
});
