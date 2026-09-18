import { describe, expect, test } from "vite-plus/test";
import { interruptContinuationError, interruptContinuationState } from "./interrupt-recovery.ts";

describe("interrupt continuation recovery", () => {
  test("treats a new approval as proof that the continuation started", () => {
    expect(interruptContinuationState(interruptContinuationError, 1)).toBe("continued");
  });

  test("only treats the continuation as lost when no approval replaced it", () => {
    expect(interruptContinuationState(interruptContinuationError, 0)).toBe("lost");
    expect(interruptContinuationState("another error", 0)).toBe("none");
    expect(interruptContinuationState(undefined, 0)).toBe("none");
  });
});
