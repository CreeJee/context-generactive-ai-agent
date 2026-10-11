import { NodeServices } from "@effect/platform-node";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Context, Layer, Stream } from "effect";
import { it } from "@effect/vitest";
import { Cause, FileSystem, Path } from "effect";
import { withTestPlatform } from "./support/platform.ts";
import { HashSet } from "effect";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { build } from "vite";
import { expect } from "vite-plus/test";

// Test-only native durability across finite processes; not production adoption or Goal recovery.
it.live(
  "cold native reopen reads exact completed run before one explicit fresh saved-factory turn",
  () =>
    withTestPlatform(
      Effect.gen(function* () {
        const platform = yield* Layer.build(NodeServices.layer);
        const spawner = Context.get(platform, ChildProcessSpawner.ChildProcessSpawner);
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const join = pathService.join;
        const root = yield* pathService.fromFileUrl(new URL("../", import.meta.url));
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: root,
          prefix: ".native-cold-reopen-",
        });
        const source = join(temporary, "src");
        yield* fs.copy(join(root, "src"), source);
        const allowed = HashSet.fromIterable([
          "effect",
          "@effect/platform-node",
          "@tanstack/ai",
          "@secretlint/core",
          "@secretlint/profiler",
          "@secretlint/secretlint-rule-preset-recommend",
        ]);
        const external = (id: string) => {
          if (id.startsWith("node:")) return true;
          if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) return false;
          const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
          if (!HashSet.has(allowed, name)) throw new Error(`Unexpected host dependency: ${id}`);
          return true;
        };
        const result = yield* sdkCall(() =>
          build({
            configFile: false,
            root,
            logLevel: "silent",
            build: {
              write: false,
              minify: false,
              lib: { entry: join(source, "agent/native-artifact-entry.ts"), formats: ["es"] },
              rollupOptions: { external },
            },
          }),
        );
        const outputs = Array.isArray(result) ? result : [result];
        expect(outputs).toHaveLength(1);
        // SAFETY: finite non-watch configFile:false build; output count verified above.
        const output = outputs[0] as Extract<
          Awaited<ReturnType<typeof build>>,
          { output: unknown }
        >;
        const chunks = output.output.filter((item) => item.type === "chunk");
        expect(chunks).toHaveLength(1);
        const chunk = chunks[0]!;
        expect(chunk.exports.toSorted()).toEqual(
          [
            "createMemoryTools",
            "createSubscriptionRuntimeImplementation",
            "makePermissionGateMiddleware",
            "makeRecordingMiddleware",
          ].toSorted(),
        );
        expect(Object.keys(chunk.modules)).toContain(join(source, "memory/record.ts"));
        expect(chunk.imports.every(external)).toBe(true);
        expect(Buffer.byteLength(chunk.code)).toBeLessThan(2_000_000);
        const artifact = join(temporary, "saved.mjs");
        yield* fs.writeFileString(artifact, chunk.code, { flag: "wx" });
        yield* fs.remove(source, { recursive: true });
        const Report = Schema.fromJsonString(
          Schema.Struct({
            acquired: Schema.Finite,
            released: Schema.Finite,
            sqliteClosed: Schema.Boolean,
            pid: Schema.Finite,
            verifiedOld: Schema.Boolean,
          }),
        );
        const loaderPath = yield* pathService.fromFileUrl(
          new URL("./fixtures/native-test-loader.ts", import.meta.url),
        );
        const childPath = yield* pathService.fromFileUrl(
          new URL("./support/native-artifact-cold-reopen-child.ts", import.meta.url),
        );
        const reports = [];
        for (const phase of ["first", "second"] as const) {
          // Await close/reap before starting next process or deleting owned fixtures.
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "--experimental-strip-types",
                "--import",
                loaderPath,
                childPath,
                temporary,
                artifact,
                phase,
              ],
              {
                cwd: root,
                env: { NODE_OPTIONS: "", HOME: join(temporary, "home") },
                extendEnv: true,

                killSignal: "SIGKILL",
              },
            ),
          );
          const [, stderr, exitCode] = yield* Effect.all(
            [
              Stream.runDrain(handle.stdout),
              Stream.runCollect(handle.stderr.pipe(Stream.decodeText())),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("30 seconds"));
          expect(exitCode, stderr.join("")).toBe(0);
          const report = yield* Schema.decodeEffect(Report)(
            yield* fs.readFileString(join(temporary, `${phase}.json`)),
          );
          expect(report).toMatchObject({
            acquired: 1,
            released: 1,
            sqliteClosed: true,
            verifiedOld: phase === "second",
          });
          expect(report.pid).not.toBe(process.pid);
          reports.push(report);
        }
        expect(reports[0]!.pid).not.toBe(reports[1]!.pid);
        expect(yield* fs.readFileString(artifact)).toBe(chunk.code);
        const sqlite = new DatabaseSync(join(temporary, "storage", "agent.db"), { readOnly: true });
        try {
          expect(
            sqlite
              .prepare("SELECT run_id, text FROM nodes WHERE kind = 'assistant' ORDER BY rowid")
              .all(),
          ).toEqual([
            { run_id: "first", text: "first" },
            { run_id: "second", text: "second" },
          ]);
          expect(
            sqlite
              .prepare("SELECT run_id, status FROM chat_runs ORDER BY started_at, run_id")
              .all(),
          ).toEqual([
            { run_id: "first", status: "completed" },
            { run_id: "second", status: "completed" },
          ]);
          expect(
            sqlite.prepare("SELECT COUNT(*) AS count FROM nodes WHERE kind = 'user'").get(),
          ).toMatchObject({ count: 2 });
        } finally {
          sqlite.close();
        }
      }),
    ),
  90_000,
);

const sdkCall = Effect.fn("NativeArtifactTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
