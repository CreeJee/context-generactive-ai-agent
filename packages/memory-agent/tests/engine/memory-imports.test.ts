import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Importer } from "../../src/imports/importer.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { sqlAll } from "../support/sql.ts";
import { writeClaude } from "../support/transcripts.ts";

const runOnce = Effect.flatMap(Importer, (importer) => importer.runOnce);

const decodeIndexed = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ text: Schema.String })),
);

/** Importing reads the whole home and writes into the whole store, so the test owns its agent. */
testAgent()("migrating other agents' transcripts", (it) => {
  it.effect("indexes what was said today before a migrated backlog", () =>
    Effect.gen(function* () {
      const { project, session } = yield* TestEnv;
      yield* writeClaude;
      // The transcript is from March; this is now. Its rows land last but it must index first.
      const today = yield* (yield* Nodes).append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: "오늘 한 말",
      });
      yield* runOnce;
      yield* (yield* Indexer).indexUpTo(1);
      const indexed = yield* decodeIndexed(
        yield* sqlAll(
          "SELECT n.text FROM node_vectors v JOIN nodes n ON n.seq = v.node_seq ORDER BY n.seq",
        ),
      );
      expect(indexed.map((row) => row.text)).toEqual([today.text]);
    }),
  );
});
