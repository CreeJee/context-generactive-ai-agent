import { describe, expect, test } from "vite-plus/test";
import { ApiError, chatFetch } from "../api";

describe("chat transport errors", () => {
  test("preserves a provider failure code from a rejected stream response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({ error: "provider_auth_unavailable", provider: "openai" }, { status: 503 });
    try {
      await expect(chatFetch("/api/chat")).rejects.toMatchObject({
        status: 503,
        code: "provider_auth_unavailable",
      } satisfies Partial<ApiError>);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
