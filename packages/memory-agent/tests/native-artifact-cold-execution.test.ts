import { it } from "@effect/vitest";
import { Cause, FileSystem, Path } from "effect";
import { withTestPlatform } from "./support/platform.ts";
import { HashSet } from "effect";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";
import { build } from "vite";
import { expect } from "vite-plus/test";

// Test-only saved factory execution. No production loader, owner adoption or whole-Goal pinning.
it.live(
  "fresh Node executes saved recording factory after source removal and persists evidence",
  () =>
    withTestPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const join = pathService.join;
        const root = yield* pathService.fromFileUrl(new URL("../", import.meta.url));
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: root,
          prefix: ".native-cold-execution-",
        });
        const source = join(temporary, "src");
        yield* fs.copy(join(root, "src"), source);
        const allowed = HashSet.fromIterable([
          "effect",
          "@effect/platform-node",
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
        const bundle = Effect.fn("NativeArtifactTest.bundle")(function* (name: string) {
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
          // SAFETY: configFile:false, finite non-watch build; output count verified above.
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
          const path = join(temporary, `${name}.mjs`);
          yield* fs.writeFileString(path, chunk.code, { flag: "wx" });
          return { path, code: chunk.code };
        });
        const loaderPath = yield* pathService.fromFileUrl(
          new URL("./fixtures/native-test-loader.ts", import.meta.url),
        );
        const childPath = yield* pathService.fromFileUrl(
          new URL("./support/native-artifact-cold-execution-child.ts", import.meta.url),
        );
        const a = yield* bundle("a");
        const implementation = join(source, "memory/record.ts");
        const original = yield* fs.readFileString(implementation);
        const needle = 'kind: "assistant",\n      text,';
        expect(original.split(needle)).toHaveLength(2);
        yield* fs.writeFileString(
          implementation,
          original.replace(needle, 'kind: "assistant",\n      text: `copied-B:${text}`,'),
        );
        const b = yield* bundle("b");
        expect(b.code).not.toBe(a.code);
        expect(yield* fs.readFileString(a.path)).toBe(a.code);
        yield* fs.remove(source, { recursive: true });
        // Existing verified loader transforms host TS and loads real native addons; saved .mjs is native ESM.
        // execFile waits for child close/reap; finite timeout kills with SIGKILL, no background process.
        yield* sdkCall(() =>
          promisify(execFile)(
            process.execPath,
            [
              "--experimental-strip-types",
              "--import",
              loaderPath,
              childPath,
              temporary,
              a.path,
              b.path,
            ],
            {
              cwd: root,
              env: { ...process.env, NODE_OPTIONS: "" },
              timeout: 30_000,
              killSignal: "SIGKILL",
              maxBuffer: 1_000_000,
            },
          ),
        );
        const report = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              acquired: Schema.Finite,
              released: Schema.Finite,
              sqliteClosed: Schema.Boolean,
              pid: Schema.Finite,
            }),
          ),
        )(yield* fs.readFileString(join(temporary, "result.json")));
        expect(report).toMatchObject({ acquired: 1, released: 1, sqliteClosed: true });
        expect(report.pid).not.toBe(process.pid);
        // Independent read-only SQLite connection AFTER child exit: durable evidence, not service/owner adoption.
        const sqlite = new DatabaseSync(join(temporary, "storage", "agent.db"), { readOnly: true });
        try {
          const rows = sqlite
            .prepare("SELECT run_id, text FROM nodes WHERE kind = 'assistant' ORDER BY rowid")
            .all();
          expect(rows).toEqual([
            { run_id: "a-first", text: "a-first" },
            { run_id: "b", text: "copied-B:b" },
            { run_id: "a-next", text: "a-next" },
          ]);
          expect(
            sqlite.prepare("SELECT COUNT(*) AS count FROM nodes WHERE kind = 'user'").get(),
          ).toMatchObject({ count: 3 });
        } finally {
          sqlite.close();
        }
      }),
    ),
  60_000,
);

const sdkCall = Effect.fn("NativeArtifactTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
