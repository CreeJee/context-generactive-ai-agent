import { Tool } from "effect/ai";
import { getEncoding } from "js-tiktoken";
import { describe, expect, test } from "vite-plus/test";
import { estimateRequestTokens, exceedsRequestTokenBudget } from "../eval/request-token-budget.ts";
import { toPrompt } from "../src/model/prompt.ts";
import { subscriptionBody } from "../src/model/subscription.ts";

describe("paid pilot OpenAI token preflight", () => {
  test("counts serialized ASCII and Korean with the selected fallback BPE", () => {
    const encoder = getEncoding("o200k_base");
    for (const request of ['{"input":"hello world"}', '{"input":"안녕하세요 도구를 읽어주세요"}']) {
      const estimate = estimateRequestTokens(request, "gpt-5.6-sol");
      expect(estimate).toEqual({
        estimatedTokens: encoder.encode(request).length,
        encoding: "o200k_base",
        fallback: true,
      });
      expect(estimate.estimatedTokens).toBeGreaterThan(0);
    }
  });

  test("uses a known model mapping but marks unknown models as fallback", () => {
    const known = estimateRequestTokens("hello", "gpt-4o");
    expect(known).toMatchObject({ encoding: "o200k_base", fallback: false });
    expect(estimateRequestTokens("hello", "unknown-catalog-model")).toMatchObject({
      encoding: "o200k_base",
      fallback: true,
    });
  });

  test("the request includes tool schemas and the budget stops before a provider call", () => {
    const prompt = toPrompt(
      [{ role: "user", content: "Read the fixture" }],
      ["Keep evidence pointers."],
    );
    const tools = [
      Tool.dynamic("lookup", {
        description: "Find evidence",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      }),
    ];
    const selection = {
      provider: "openai" as const,
      model: "gpt-5.6-sol",
      reasoningEffort: "low" as const,
    };
    const withTools = subscriptionBody({
      provider: "openai",
      selection,
      prompt,
      tools,
      promptCache: undefined,
    });
    const withoutTools = subscriptionBody({
      provider: "openai",
      selection,
      prompt,
      tools: [],
      promptCache: undefined,
    });
    expect(withTools).toContain('"parameters":');
    const large = estimateRequestTokens(withTools, selection.model);
    const small = estimateRequestTokens(withoutTools, selection.model);
    expect(large.estimatedTokens).toBeGreaterThan(small.estimatedTokens);
    expect(exceedsRequestTokenBudget(large, Math.ceil(large.estimatedTokens * 1.25) - 1)).toBe(
      true,
    );
    expect(exceedsRequestTokenBudget(large, Math.ceil(large.estimatedTokens * 1.25))).toBe(false);
  });
});
