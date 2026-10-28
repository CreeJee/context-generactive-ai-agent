import { describe, expect, it } from "vite-plus/test";
import { isTruthy } from "../src/truthy.ts";

describe("explicit truthiness", () => {
  it("preserves JavaScript conditions, including NaN and negative zero", () => {
    [false, 0, -0, 0n, "", null, undefined, Number.NaN].forEach((value) =>
      expect(isTruthy(value)).toBe(false),
    );
    [true, -1, 1n, "0", [], {}, () => undefined].forEach((value) =>
      expect(isTruthy(value)).toBe(true),
    );
  });
});
