import { describe, expect, it } from "@effect/vitest";
import { coldObservationId, type StoredContextUsage } from "./context-usage.ts";

const usage = (cachedTokens: number | null, observationId: string | null): StoredContextUsage => ({
  inputTokens: 100,
  cachedTokens,
  observationId,
  compactionStage: "none",
});

describe("cache-cold observation", () => {
  it("only explicit identifiable zero triggers, once per provider observation", () => {
    expect(coldObservationId(null, null)).toBeNull();
    expect(coldObservationId(usage(null, "first"), null)).toBeNull();
    expect(coldObservationId(usage(12, "first"), null)).toBeNull();
    expect(coldObservationId(usage(0, null), null)).toBeNull();
    expect(coldObservationId(usage(0, "first"), null)).toBe("first");
    expect(coldObservationId(usage(0, "first"), "first")).toBeNull();
    expect(coldObservationId(usage(0, "second"), "first")).toBe("second");
  });
});
