import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Schema } from "effect";
import { build } from "vite";
import { expect, test } from "vite-plus/test";

// Test-only native durability across finite processes; not production adoption or Goal recovery.
test("cold native reopen reads exact completed run before one explicit fresh saved-factory turn", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await mkdtemp(join(root, ".native-cold-reopen-"));
  try {
    const source = join(temporary, "src");
    await cp(join(root, "src"), source, { recursive: true });
    const allowed = new Set([
      "effect",
      "@tanstack/ai",
      "@secretlint/core",
      "@secretlint/profiler",
      "@secretlint/secretlint-rule-preset-recommend",
    ]);
    const external = (id: string) => {
      if (id.startsWith("node:")) return true;
      if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) return false;
      const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
      if (!allowed.has(name)) throw new Error(`Unexpected host dependency: ${id}`);
      return true;
    };
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        lib: { entry: join(source, "agent/native-artifact-entry.ts"), formats: ["es"] },
        rollupOptions: { external },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    expect(outputs).toHaveLength(1);
    // SAFETY: finite non-watch configFile:false build; output count verified above.
    const output = outputs[0] as Extract<Awaited<ReturnType<typeof build>>, { output: unknown }>;
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
    await writeFile(artifact, chunk.code, { flag: "wx" });
    await rm(source, { recursive: true });
    const Report = Schema.fromJsonString(
      Schema.Struct({
        acquired: Schema.Finite,
        released: Schema.Finite,
        sqliteClosed: Schema.Boolean,
        pid: Schema.Finite,
        verifiedOld: Schema.Boolean,
      }),
    );
    const reports = [];
    for (const phase of ["first", "second"] as const) {
      // Await close/reap before starting next process or deleting owned fixtures.
      await promisify(execFile)(
        process.execPath,
        [
          "--experimental-strip-types",
          "--import",
          fileURLToPath(new URL("./fixtures/native-test-loader.ts", import.meta.url)),
          fileURLToPath(new URL("./support/native-artifact-cold-reopen-child.ts", import.meta.url)),
          temporary,
          artifact,
          phase,
        ],
        {
          cwd: root,
          env: { ...process.env, NODE_OPTIONS: "", HOME: join(temporary, "home") },
          timeout: 30_000,
          killSignal: "SIGKILL",
          maxBuffer: 1_000_000,
        },
      );
      const report = Schema.decodeUnknownSync(Report)(
        await readFile(join(temporary, `${phase}.json`), "utf8"),
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
    expect(await readFile(artifact, "utf8")).toBe(chunk.code);
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
        sqlite.prepare("SELECT run_id, status FROM chat_runs ORDER BY started_at, run_id").all(),
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
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 90_000);
