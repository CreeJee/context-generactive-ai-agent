import { SqlError } from "effect/sql";
import { describe, expect, it } from "vite-plus/test";
import { CardWorktreeFailed, CardWorktreeFailedReason } from "../kanban/worktree.ts";
import { IndexingError } from "../memory/embedding/indexer.ts";
import { VectorIndexError } from "../memory/embedding/vector-index.ts";
import { causeTagsOf, errorCodesOf, failureNameOf, withErrorCodes } from "./failure-tag.ts";

const locked = SqlError.SqlError.make({
  reason: SqlError.LockTimeoutError.make({ cause: new Error("database is locked") }),
});

describe("causeTagsOf", () => {
  it("names each tagged cause down the chain and stops at the first untagged one", () => {
    const error = IndexingError.make({
      reason: "read-failed",
      cause: VectorIndexError.make({ operation: "search", cause: locked }),
    });
    expect(causeTagsOf(error)).toEqual(["VectorIndexError", "SqlError:LockTimeoutError"]);
    expect(causeTagsOf(IndexingError.make({ reason: "read-failed" }))).toEqual([]);
  });

  it("starts after the failure's own reason, but keeps a cause that is not its reason", () => {
    expect(failureNameOf(locked)).toBe("SqlError:LockTimeoutError");
    expect(causeTagsOf(locked)).toEqual([]);
    const failed = CardWorktreeFailed.make({
      operation: "checkout",
      reason: CardWorktreeFailedReason.cases.GitFailed.make({ exitCode: 128 }),
      cause: locked,
    });
    expect(failureNameOf(failed)).toBe("CardWorktreeFailed:GitFailed");
    expect(causeTagsOf(failed)).toEqual(["SqlError:LockTimeoutError"]);
  });
});

describe("errorCodesOf", () => {
  it("reads the system codes down the cause chain, never the errors' text", () => {
    // A fetch that could not connect, as undici reports it.
    const fetchFailed = new TypeError("fetch failed", {
      cause: Object.assign(new Error("Connect Timeout Error (attempted address: 10.0.0.9:80)"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    const failed = VectorIndexError.make({ operation: "search", cause: fetchFailed });
    expect(errorCodesOf(failed)).toEqual(["UND_ERR_CONNECT_TIMEOUT"]);
    expect(withErrorCodes("VectorIndexError", failed)).toBe(
      "VectorIndexError (UND_ERR_CONNECT_TIMEOUT)",
    );
  });

  it("leaves out codes that are words, and a name without codes stays as it was", () => {
    const worded = Object.assign(new Error("rejected"), { code: "invalid api key for this url" });
    expect(errorCodesOf(worded)).toEqual([]);
    expect(withErrorCodes("ProviderRejected", worded)).toBe("ProviderRejected");
  });
});
