import { SqlError } from "effect/sql";
import { describe, expect, it } from "vite-plus/test";
import { IndexingError } from "../memory/embedding/indexer.ts";
import { VectorIndexError } from "../memory/embedding/vector-index.ts";
import { causeTagsOf } from "./failure-tag.ts";

describe("causeTagsOf", () => {
  it("names each tagged cause down the chain and stops at the first untagged one", () => {
    const locked = SqlError.SqlError.make({
      reason: SqlError.LockTimeoutError.make({ cause: new Error("database is locked") }),
    });
    const error = IndexingError.make({
      reason: "read-failed",
      cause: VectorIndexError.make({ operation: "search", cause: locked }),
    });
    expect(causeTagsOf(error)).toEqual(["VectorIndexError", "SqlError:LockTimeoutError"]);
    expect(causeTagsOf(IndexingError.make({ reason: "read-failed" }))).toEqual([]);
  });
});
