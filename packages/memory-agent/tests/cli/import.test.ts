import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path, Schema } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { GlobalConfig } from "../../src/config/global-config.ts";
import { runImportPass } from "../../src/cli/import-run.ts";
import { importStatus } from "../../src/cli/import-status.ts";
import { readOnlyMemoryLayer } from "../../src/cli/read-only-storage.ts";
import { writableMemoryLayer } from "../../src/cli/writable-storage.ts";
import { StorageLockHeld, lockStorageRoot } from "../../src/runtime/storage-lock.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Projects } from "../../src/projects/projects.ts";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";
import { claudeLines, writeTranscript } from "../support/transcripts.ts";

/**
 * What types cannot show about importing from the CLI: that a second writer is refused instead of
 * taking a storage folder the app owns, that one pass over a transcript the app never saw ends up
 * in memory that `find-memory` reaches, and that interpretation stays off unless it is asked for.
 */

/** A throwaway home holding one Claude Code conversation, plus the storage to import it into. */
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "cli-import-" }));
  const home = path.join(base, "home");
  const storage = path.join(base, "storage");
  const projectRoot = path.join(base, "project");
  yield* fs.makeDirectory(projectRoot, { recursive: true });
  const directory = path.join(home, ".claude", "projects", "encoded-cwd");
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* writeTranscript(path.join(directory, "cc-1.jsonl"), claudeLines(projectRoot));
  return { base, home, storage, projectRoot };
});

layer(NodeServices.layer)((it) => {
  it.effect(
    "imports a conversation the app never saw and finds it again",
    () =>
      Effect.gen(function* () {
        const { home, projectRoot, storage } = yield* fixture();
        const result = yield* runImportPass({
          storage,
          interpret: false,
          noIndex: false,
        }).pipe(
          Effect.scoped,
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(
            writableMemoryLayer({ storage, importsHome: home, embedder: fakeEmbedderLayer }),
          ),
        );
        // The pass walked both sources and wrote the one conversation that was there.
        expect(result.pass?.failed).toBe(0);
        expect(result.pass?.written).toBeGreaterThan(0);
        expect(result.indexed.skipped).toBe(false);
        // Interpretation was not asked for, so the import left it off.
        expect(result.interpret).toBe(false);

        // The storage the CLI created on its own is now readable, and holds the conversation.
        const found = yield* Effect.gen(function* () {
          const projects = yield* Effect.flatMap(Projects, (service) => service.listAll);
          const project = projects.find((entry) => entry.root === projectRoot);
          if (project === undefined)
            return expect.unreachable("the transcript's folder was not registered");
          const status = yield* importStatus({ storage, importsHome: home });
          const search = yield* MemorySearch;
          const matches = yield* search.find({
            query: "회상 기준",
            projectId: project.id,
            crossProject: true,
            limit: 5,
          });
          return { status, matches };
        }).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(readOnlyMemoryLayer({ storage })),
        );
        const claude = found.status.sources.find((source) => source.name === "claude-code");
        expect(claude?.transcripts).toBe(1);
        expect(claude?.migrated).toBe(1);
        expect(found.status.failures).toEqual([]);
        expect(found.matches.matches.length).toBeGreaterThan(0);
      }),
    { timeout: 120_000 },
  );

  it.effect("refuses to import while another backend owns the storage", () =>
    Effect.gen(function* () {
      const { home, storage } = yield* fixture();
      // The app's own lock, taken exactly as the server takes it.
      yield* lockStorageRoot({ storageRoot: storage, port: 5173, instanceId: "app-under-test" });
      const refused = yield* Effect.flip(
        Effect.scoped(
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(
            Effect.flatMap(GlobalConfig, (config) => config.read),
            writableMemoryLayer({ storage, importsHome: home, embedder: fakeEmbedderLayer }),
          ),
        ),
      );
      if (!Schema.is(StorageLockHeld)(refused))
        return expect.unreachable("the import was refused for another reason");
      expect(refused.port).toBe(5173);
      expect(refused.instanceId).toBe("app-under-test");
      // The owner's lock file is still there: a refused import takes nothing away.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(storage, "backend.lock"))).toBe(true);
    }).pipe(Effect.scoped),
  );
});
