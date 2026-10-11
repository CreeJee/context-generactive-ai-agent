import { withTestPlatform } from "../../../tests/support/platform.ts";
import { Crypto, Effect, FileSystem, Path } from "effect";
import { expect, it } from "vite-plus/test";
import { addonPath, loadTurbovec, type NativeReadInput } from "../../../../turbovec/index.js";
import { initializeNodeSqlite } from "../../runtime/node-sqlite-bridge.ts";
import { createReadFixture } from "./read-fixture.ts";

it("publishes only the claimed read's actual SQLite pin, never registration or pre-read rejection", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-pin-" });
          const path = paths.join(directory, "fixture.sqlite");
          const db = createReadFixture(path);
          const { VectorIndex, MemoryReadSession, SearchControl } = loadTurbovec();
          initializeNodeSqlite(addonPath);
          const reader = new MemoryReadSession(path);
          const index = new VectorIndex(384, 4);
          const owner = yield* crypto.randomUUIDv4();
          const input: NativeReadInput = {
            allowedProjects: ["allowed"],
            embedder: "fixture",
            trigramTerms: [],
            shortTerms: [],
            morphTerms: [],
            vectorK: 1,
            textK: 1,
            morphK: 1,
            textEnabled: false,
            morphEnabled: false,
            remainingMs: 2_000,
            inputBudgetBytes: 65_536,
            outputBudgetBytes: 4_096,
          };
          const baseline = SearchControl.count();
          try {
            for (const mode of ["read", "expired", "invalid", "cancelled"] as const) {
              const control = new SearchControl(
                yield* crypto.randomUUIDv4(),
                owner,
                "pin-epoch",
                mode,
                mode === "expired" ? 0 : 2_000,
              );
              try {
                expect(control.snapshotWasPinned()).toBe(false);
                if (mode === "cancelled") control.cancel();
                const result = reader.search(
                  index,
                  mode === "invalid" ? { ...input, embedder: "" } : input,
                  control.token(),
                  owner,
                  "pin-epoch",
                  mode,
                );
                const expected = {
                  read: "success",
                  expired: "budget-exceeded",
                  invalid: "invalid-input",
                  cancelled: "cancelled",
                }[mode];
                expect(result.kind).toBe(expected);
                expect(control.snapshotWasPinned()).toBe(mode === "read");
                // Claiming that token again cannot create another read or pin a fresh control.
                expect(
                  reader.search(index, input, control.token(), owner, "pin-epoch", mode).kind,
                ).toBe("invalid-input");
                control.close();
                expect(control.snapshotWasPinned()).toBe(mode === "read"); // Event is historical, not a live lease.
              } finally {
                control.close();
              }
              expect(SearchControl.count()).toBe(baseline);
            }
          } finally {
            reader.close();
            db.close();
          }
        }),
      ),
    ),
  ));
