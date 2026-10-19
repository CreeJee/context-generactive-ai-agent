// Builds the RRSI usage corpus: a storage snapshot plus memory tasks made from real user corrections.
// Usage: node eval/rrsi-usage-corpus.ts <out-dir> <compatible-config.json> [source-storage]
import { NodeServices } from "@effect/platform-node";
import { Clock, Console, Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { defaultStorageRoot } from "../src/config/storage-root.ts";
import { connectionContext } from "../src/db/database.ts";
import { sha256 } from "../src/runtime/synchronous-crypto.ts";
import {
  GeneratedQuestion,
  UsageCorpus,
  UsageTask,
  decisionInCorrection,
  generationPrompt,
  usageSplit,
} from "../src/rrsi/usage-corpus.ts";

class CorpusBuildFailed extends Schema.TaggedError<CorpusBuildFailed>()("CorpusBuildFailed", {
  reason: Schema.Literals(["usage", "config", "snapshot", "query"]),
}) {}

const Endpoint = Schema.Struct({
  openaiCompatible: Schema.Struct({ baseUrl: Schema.String, model: Schema.String }),
});
const Correction = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  session_id: Schema.String,
  text: Schema.String,
  corrected: Schema.String,
});
const Completion = Schema.Struct({
  choices: Schema.NonEmptyArray(
    Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) }),
  ),
});
type Generation =
  | { readonly kind: "task"; readonly task: UsageTask }
  | { readonly kind: "dropped" }
  | { readonly kind: "failed" };
// Long messages carry pasted logs; the decision is in the user's own words near the start.
const clip = (text: string) => text.slice(0, 4000);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [out, configFile, source = defaultStorageRoot] = process.argv.slice(2);
  if (out === undefined || configFile === undefined)
    return yield* CorpusBuildFailed.make({ reason: "usage" });
  const endpoint = yield* fs.readFileString(configFile).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Endpoint))),
    Effect.mapError(() => CorpusBuildFailed.make({ reason: "config" })),
  );

  const staging = path.join(out, "staging");
  yield* fs.remove(staging, { recursive: true, force: true });
  yield* fs.makeDirectory(staging, { recursive: true });
  // A consistent copy of the live database; the source is opened read-only.
  const corrections = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(path.join(source, "agent.db"), { readOnly: true })),
    (database) => Effect.sync(() => database.close()),
  ).pipe(
    Effect.flatMap(connectionContext),
    Effect.flatMap((context) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`VACUUM INTO ${path.join(staging, "agent.db")}`.pipe(
          Effect.mapError(() => CorpusBuildFailed.make({ reason: "snapshot" })),
        );
        const rows = yield* sql`SELECT u.id, u.project_id, u.session_id, u.text, t.text AS corrected
          FROM edges e JOIN nodes u ON u.id = e.from_id JOIN nodes t ON t.id = e.to_id
          WHERE e.kind = 'corrects' AND u.kind = 'user' ORDER BY u.seq`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Correction))),
          Effect.mapError(() => CorpusBuildFailed.make({ reason: "query" })),
        );
        return rows;
      }).pipe(Effect.provideContext(context)),
    ),
    Effect.scoped,
  );
  yield* fs
    .copy(path.join(source, "vectors"), path.join(staging, "vectors"))
    .pipe(Effect.mapError(() => CorpusBuildFailed.make({ reason: "snapshot" })));
  yield* Console.log(`snapshot ready; ${corrections.length} corrections`);

  const client = yield* HttpClient.HttpClient;
  const generate = (correction: typeof Correction.Type) =>
    HttpClientRequest.post(`${endpoint.openaiCompatible.baseUrl}/chat/completions`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model: endpoint.openaiCompatible.model,
        max_tokens: 16384,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: generationPrompt(clip(correction.text), clip(correction.corrected)),
          },
        ],
      }),
      client.execute,
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Completion)),
      Effect.flatMap((completion) =>
        Schema.decodeEffect(Schema.fromJsonString(GeneratedQuestion))(
          completion.choices[0].message.content ?? "",
        ),
      ),
      Effect.map((generated): Generation =>
        generated.keep && decisionInCorrection(generated.decision, correction.text)
          ? {
              kind: "task",
              task: {
                id: correction.id,
                split: usageSplit(correction.session_id),
                projectId: correction.project_id,
                correctionNodeId: correction.id,
                question: generated.question,
                decision: generated.decision,
              },
            }
          : { kind: "dropped" },
      ),
      // One unusable reply drops that correction; the count is reported, not hidden.
      Effect.catchTags({
        HttpClientError: () => Effect.succeed<Generation>({ kind: "failed" }),
        SchemaError: () => Effect.succeed<Generation>({ kind: "failed" }),
      }),
    );
  const results = yield* Effect.forEach(corrections, generate, { concurrency: 4 });
  const tasks = results.flatMap((result) => (result.kind === "task" ? [result.task] : []));
  const failed = results.filter((result) => result.kind === "failed").length;
  const encodedTasks = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(UsageTask)))(
    tasks,
  );
  const version = sha256(encodedTasks).slice(0, 12);
  const corpus: UsageCorpus = { version, createdAt: yield* Clock.currentTimeMillis, tasks };
  yield* fs.writeFileString(
    path.join(staging, "corpus.json"),
    `${yield* Schema.encodeEffect(Schema.fromJsonString(UsageCorpus))(corpus)}\n`,
  );
  const target = path.join(out, version);
  yield* fs.remove(target, { recursive: true, force: true });
  yield* fs.rename(staging, target);
  yield* fs.writeFileString(path.join(out, "current"), `${version}\n`);
  const count = (split: UsageTask["split"]) => tasks.filter((task) => task.split === split).length;
  yield* Console.log(
    `corpus ${version}: ${tasks.length} tasks (evolve ${count("evolve")}, validation ${count("validation")}, sealed ${count("sealed")}); dropped ${results.length - tasks.length - failed}, failed ${failed}`,
  );
});

await Effect.runPromise(
  program.pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeServices.layer)),
);
