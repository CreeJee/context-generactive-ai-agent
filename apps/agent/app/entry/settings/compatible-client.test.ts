import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { compatibleClient } from "./compatible-client";
const fetcher = vi.fn();

beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
});
afterEach(() => vi.unstubAllGlobals());
test("update preserves an omitted key and sends null only for explicit removal", async () => {
  const configuration = {
    baseUrl: "http://localhost:8080/v1",
    model: "local-model",
    contextWindow: 32768,
    outputBudget: 4096,
    toolCalling: false,
  };
  await compatibleClient.update(configuration);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
    action: "update",
    ...configuration,
  });
  await compatibleClient.update({ ...configuration, apiKey: null });
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).apiKey).toBeNull();
});
test("test and optional catalog refresh use saved settings without sending credentials", async () => {
  await compatibleClient.test();
  await compatibleClient.list();
  expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
    { action: "test" },
    { action: "list" },
  ]);
});
test("partial-save error instructs reload without reading a secret response body", async () => {
  const json = vi.fn(async () => ({ error: "private upstream detail" }));
  fetcher.mockResolvedValue({ ok: false, status: 409, json });
  await expect(compatibleClient.test()).rejects.toThrow("새로고침");
  expect(json).not.toHaveBeenCalled();
});
test("does not expose upstream response bodies on failure", async () => {
  const json = vi.fn(async () => ({ error: "secret upstream detail" }));
  fetcher.mockResolvedValue({ ok: false, status: 502, json });
  await expect(compatibleClient.test()).rejects.toThrow("502");
  expect(json).not.toHaveBeenCalled();
});
