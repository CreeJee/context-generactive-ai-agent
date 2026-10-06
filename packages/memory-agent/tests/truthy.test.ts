import { describe, expect, it } from "vite-plus/test";
import { isTruthy } from "../src/truthy.ts";

describe("explicit truthiness", () => {
  it("preserves JavaScript conditions, including NaN and negative zero", () => {
    for (const value of [false, 0, -0, 0n, "", null, undefined, Number.NaN])
      expect(isTruthy(value)).toBe(false);
    for (const value of [true, -1, 1n, "0", [], {}, () => undefined])
      expect(isTruthy(value)).toBe(true);
  });
});
