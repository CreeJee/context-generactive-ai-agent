import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vite-plus/test";
import { readOnlyMemoryLayer, storageEmbeddingMode } from "../../src/cli/read-only-storage.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { readStructuredEvidence, traceStructuredEvidence } from "../../src/memory/evidence.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { path } from "../../src/runtime/synchronous-path.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

/**
 * The standalone CLI opens a storage folder a running agent already owns. What types cannot show
 * is whether that second, read-only assembly opens at all next to the open agent and returns the
 * same stored text, so that is what this checks.
 */
testAgent()("the CLI's read-only storage assembly", (it) => {
  /** The CLI's own composition root, built as a command builds it, over `storage`. */
  const readOnly = (storage: string) =>
    // The entry point's platform services are merged in, as NodeServices does for the real
    // command.
    readOnlyMemoryLayer({ storage }).pipe(Layer.provide(NodeFileSystem.layer));

  /** What the `find-memory` command answers for `query` in the env's project. */
  const find = (projectId: string, query: string) =>
    Effect.flatMap(MemorySearch, (search) =>
      search.find({ projectId, query, crossProject: false, limit: 5 }),
    );

  it.effect("reads an open agent's storage without taking its locks", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* (yield* Sessions).create(env.project.id);
      const stored = yield* (yield* Nodes).append({
        projectId: env.project.id,
        sessionId: session.id,
        kind: "user",
        text: "CLI는 저장소를 읽기 전용으로만 연다",
      });
      const indexer = yield* Indexer;
      yield* indexer.lexicalAll();
      yield* indexer.indexAll();

      const read = Effect.gen(function* () {
        const found = yield* find(env.project.id, "읽기 전용");
        const page = yield* readStructuredEvidence(stored.id, 0, env.project.id, false);
        const trace = yield* traceStructuredEvidence(stored.id, env.project.id, false);
        // What the `projects` command prints: the storage's own project list, read read-only.
        const projects = yield* Effect.flatMap(Projects, (service) => service.listAll);
        return { found, page, trace, projects };
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(readOnly(env.storage)),
      );

      const { found, page, projects, trace } = yield* read;
      expect(projects.map((project) => project.id)).toContain(env.project.id);
      expect(page?.text).toContain("읽기 전용으로만");
      expect(trace).not.toBeNull();
      // The open agent holds the lexical index's writer; the CLI reads the index beside it.
      expect(found.matches.map((match) => match.id)).toContain(stored.id);
      expect(found.degraded).not.toContain("text");
    }),
  );

  it.effect("says the text channel is off when the folder has no lexical index", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* (yield* Sessions).create(env.project.id);
      yield* (yield* Nodes).append({
        projectId: env.project.id,
        sessionId: session.id,
        kind: "user",
        text: "색인 없는 저장소도 읽는다",
      });
      // A copy of the database alone: no lexical index, no vectors, no model.
      const copy = path.join(env.base, "copy");
      yield* (yield* FileSystem.FileSystem).makeDirectory(copy, { recursive: true });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${path.join(copy, "agent.db")}`;

      const found = yield* find(env.project.id, "색인 없는").pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(readOnly(copy)),
      );
      expect(found.matches).toEqual([]);
      expect(found.degraded).toContain("text");
      expect(found.degraded).toContain("vector");
    }),
  );

  it.effect("reads the vectors of the mode the folder's settings embed with", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const storage = path.join(env.base, "settings");
      yield* fs.makeDirectory(storage, { recursive: true });
      const modeWith = (settings: string) =>
        fs
          .writeFileString(path.join(storage, "config.json"), settings)
          .pipe(Effect.andThen(storageEmbeddingMode(storage)));

      // No settings file is the defaults: `auto`, which runs the gpu mode.
      expect(yield* storageEmbeddingMode(storage)).toBe("gpu");
      expect(yield* modeWith(`{ "embeddingDevice": "cpu", "importsEnabled": true }`)).toBe("cpu");
      expect(yield* modeWith(`{ "embeddingDevice": "auto" }`)).toBe("gpu");
      // The file is only read, never written back.
      expect(yield* fs.readFileString(path.join(storage, "config.json"))).toBe(
        `{ "embeddingDevice": "auto" }`,
      );
    }),
  );
});
