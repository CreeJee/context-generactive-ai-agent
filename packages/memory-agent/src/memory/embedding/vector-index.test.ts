import { describe, expect, it } from "vite-plus/test";
import { toolFailedOf } from "../../tools/failure.ts";
import { NativeOwnerFailed } from "../native-search/worker-protocol.ts";
import { VectorIndexError } from "./vector-index.ts";

describe("VectorIndexError", () => {
  it("tells the model the worker only ran out of time, so the search can run again", () => {
    const failed = toolFailedOf(
      VectorIndexError.make({
        operation: "search",
        cause: NativeOwnerFailed.make({ reason: "request-timeout" }),
      }),
    );
    expect(failed.tag).toBe("VectorIndexError");
    expect(failed.detail).toMatch(
      /^Vector index search failed \(request-timeout\)\. .*can run again\.$/,
    );
  });

  it("names a reason that retrying does not fix without promising a retry", () => {
    const detail = toolFailedOf(
      VectorIndexError.make({
        operation: "search",
        cause: NativeOwnerFailed.make({ reason: "index-failed" }),
      }),
    ).detail;
    expect(detail).toBe("Vector index search failed (index-failed).");
  });
});
