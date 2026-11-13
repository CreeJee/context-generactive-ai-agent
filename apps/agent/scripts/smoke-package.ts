import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Match,
  Path,
  Schema,
  Schedule,
  Stream,
  Option,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// This smoke fixture seeds and inspects only its temporary database with the same synchronous driver as the executable.
import { DatabaseSync } from "node:sqlite";
import { isTruthy } from "../app/truthy.ts";

const program = Effect.gen(function* () {
  const services = yield* Layer.build(
    Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp),
  );
  const fs = Context.get(services, FileSystem.FileSystem);
  const path = Context.get(services, Path.Path);
  const spawner = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
  const client = Context.get(services, HttpClient.HttpClient);
  const { join } = path;
  const app = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const windows = process.platform === "win32";
  const executableName = windows ? "context-agent.exe" : "context-agent";
  const built = join(
    app,
    "dist",
    `context-agent-${process.platform}-${process.arch}`,
    executableName,
  );
  if (!(yield* fs.exists(built))) throw new Error("no executable; run `vp run package` first");

  const temporary = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "context-agent-smoke-" }),
    (directory) =>
      fs
        .remove(directory, { recursive: true, force: true })
        .pipe(Effect.retry({ times: 5, schedule: Schedule.spaced(100) }), Effect.orDie),
  );
  const base = yield* fs.realPath(temporary);
  const executable = join(base, "bin", executableName);
  const storage = join(base, "storage");
  const project = join(base, "project");
  yield* fs.makeDirectory(join(base, "bin"));
  yield* fs.makeDirectory(project);
  yield* fs.copyFile(built, executable);

  const failures: string[] = [];
  const check = Effect.fnUntraced(function* (name: string, ok: boolean, detail = "") {
    yield* Effect.logInfo(`${ok ? "✓" : "✗"} ${name}${detail.length > 0 ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(name);
  });

  // Reserve and release a loopback port.
  const freePort = Effect.fn("smoke.freePort")(function* () {
    const { address } = yield* NodeSocketServer.make({ port: 0, host: "127.0.0.1" });
    return yield* Match.valueTags(address, {
      InetAddressV4: ({ port }) => Effect.succeed(port),
      InetAddressV6: ({ port }) => Effect.succeed(port),
      UnixPathAddress: () =>
        Effect.fail(new Cause.UnknownError(new Error("loopback listener has no TCP port"))),
    });
  }, Effect.scoped);
  // A failed probe, like one that finds nothing yet, is tried again 250 ms later until the deadline.
  const until = <T, E, R>(what: string, probe: Effect.Effect<T | null, E, R>, timeoutMs: number) =>
    probe.pipe(
      Effect.flatMap(Effect.fromNullishOr),
      Effect.retry(Schedule.spaced(250)),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(new Cause.UnknownError(new Error(`timed out waiting for ${what}`))),
      }),
      Effect.withSpan("smoke.until"),
    );
  const start = (port: number) =>
    spawner.spawn(
      ChildProcess.make(executable, ["--port", String(port), "--no-open", "--storage", storage], {
        cwd: base,
        env: { CONTEXT_AGENT_BUILD_ID: undefined, CONTEXT_AGENT_DEV_BACKEND: undefined },
        extendEnv: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
  const stop = Effect.fn("smoke.stop")(function* (child: ChildProcessSpawner.ChildProcessHandle) {
    if (yield* child.isRunning) {
      if (windows) {
        const killer = yield* spawner.spawn(
          ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        yield* killer.exitCode;
      } else yield* child.kill();
    }
    return Number(yield* child.exitCode);
  });

  const Created = Schema.Struct({ id: Schema.String });
  const Text = Schema.Struct({ text: Schema.String });
  /** Assembled at run time so no key-shaped text sits in the repository. */
  const smokeToken = `${"gh"}p_${"S1m2O3k4E5t6O7k8E9n0A1b2C3d4E5f6G7h8"}`;
  const Catalog = Schema.Struct({
    skills: Schema.Array(Schema.Struct({ name: Schema.String, scope: Schema.String })),
  });
  const json = <A, I>(
    schema: Schema.Codec<A, I>,
    response: import("effect/http/HttpClientResponse").HttpClientResponse,
  ) => response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));

  const port = yield* freePort();
  const url = `http://127.0.0.1:${port}`;
  const post = (
    route: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    client.execute(
      HttpClientRequest.post(`${url}${route}`).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );

  const started = yield* Clock.currentTimeMillis;
  const server = yield* start(port);
  yield* until(
    "the server",
    client
      .get(url)
      .pipe(
        Effect.map((response) =>
          response.status >= 200 && response.status < 300 ? response : null,
        ),
      ),
    60_000,
  );
  yield* check(
    "first start serves the app",
    true,
    `${(yield* Clock.currentTimeMillis) - started} ms`,
  );

  const page = yield* Effect.flatMap(client.get(url), (response) => response.text);
  const asset = /\/assets\/[^"]+\.js/.exec(page)?.[0];
  const assetResponse = isTruthy(asset) ? yield* client.get(`${url}${asset}`) : null;
  yield* check(
    "client assets with immutable caching",
    assetResponse?.status === 200 &&
      (assetResponse.headers["cache-control"] ?? "").includes("immutable"),
  );

  const badHost = yield* client
    .get(`${url}/api/auth?provider=openai`, { headers: { host: "evil.example" } })
    .pipe(Effect.map((response) => response.status));
  yield* check("non-loopback Host refused", badHost === 403, String(badHost));
  const crossSite = yield* post(
    "/api/auth",
    { intent: "logout", provider: "openai" },
    { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  );
  yield* check("cross-site POST refused", crossSite.status === 403, String(crossSite.status));

  const created = yield* post("/api/projects", { root: project });
  yield* check(
    "project added (SQLite, vector index)",
    created.status === 201,
    String(created.status),
  );
  const projectId = created.status === 201 ? (yield* json(Created, created)).id : "";
  const session = yield* post("/api/sessions", { projectId });
  yield* check("session created", session.status === 201, String(session.status));
  const kagi = yield* client.get(`${url}/api/settings/kagi`);
  yield* check("keychain addon loads (Kagi status)", kagi.status === 200, String(kagi.status));
  // Built-in skills are found next to the unpacked runtime, a path only the executable takes.
  const catalog = yield* json(
    Catalog,
    yield* client.get(`${url}/api/projects/${projectId}/skills`),
  );
  const builtin = catalog.skills.filter((skill) => skill.scope === "builtin");
  yield* check(
    "built-in skills unpacked and listed",
    builtin.some((skill) => skill.name === "draw"),
    builtin.map((skill) => skill.name).join(", ") || "none",
  );

  const initialize = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        jsonrpc: Schema.Literal("2.0"),
        id: Schema.Literal(1),
        method: Schema.Literal("initialize"),
        params: Schema.Struct({
          protocolVersion: Schema.Literal(1),
          clientCapabilities: Schema.Struct({}),
        }),
      }),
    ),
  )({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  const acp = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, ["acp", "--port", String(port)], {
          stdin: Stream.make(new TextEncoder().encode(`${initialize}\n`)),
          stderr: "ignore",
        }),
      );
      return yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, part) => text + part,
        ),
      );
    }),
  ).pipe(Effect.timeout(30_000));
  yield* check("acp answers initialize on stdout", acp.includes('"agentInfo"'), acp.slice(0, 80));

  const code = yield* stop(server);
  yield* check("server shuts down cleanly", windows || code === 0, `exit ${code}`);

  // A node stored the way it was before secrets were hidden on the way in; the start below sweeps
  // it. This check exercises the packaged secret detector.
  const sessionId = session.status === 201 ? (yield* json(Created, session)).id : "";
  const seededAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  const seeded = yield* Effect.sync(() => {
    const database = new DatabaseSync(join(storage, "agent.db"));
    try {
      database
        .prepare(
          "INSERT INTO nodes (id, project_id, session_id, kind, text, created_at) VALUES ('smoke-secret', ?, ?, 'tool_result', ?, ?)",
        )
        .run(projectId, sessionId, `GITHUB_TOKEN=${smokeToken}`, seededAt);
      return true;
    } finally {
      database.close();
    }
  });

  const secondServer = yield* start(port);
  yield* until(
    "the second start",
    client
      .get(url)
      .pipe(
        Effect.map((response) =>
          response.status >= 200 && response.status < 300 ? response : null,
        ),
      ),
    60_000,
  );
  // The agent (and the sweep it starts) is made on the first API request, as the page makes one.
  yield* client.get(`${url}/api/auth`);
  const swept = yield* until(
    "the secret sweep",
    Effect.sync(() => {
      const database = new DatabaseSync(join(storage, "agent.db"), { readOnly: true });
      try {
        const row = database.prepare("SELECT text FROM nodes WHERE id = 'smoke-secret'").get();
        const text = isTruthy(row)
          ? Schema.decodeUnknownOption(Text)(row).pipe(
              Option.map((value) => value.text),
              Option.getOrElse(() => ""),
            )
          : "";
        return text.includes(smokeToken) ? null : text;
      } finally {
        database.close();
      }
    }),
    30_000,
  );
  yield* check(
    "stored secrets swept on start (bundled detector)",
    seeded && swept === "GITHUB_TOKEN=[redacted:github]",
    swept,
  );
  yield* stop(secondServer);

  // ── the memory CLI over the packaged executable ─────────────────────
  // The executable answers `context-agent memory …` itself (server/main.ts): one JSON line on
  // stdout, progress only on stderr, refusals with exit status 2. A synthetic imports-home holds
  // one Claude Code conversation; the import writes it into a fresh storage folder and indexes it
  // (no model file is cached there, so the vector channel reports itself degraded while the
  // lexical index answers find-memory) and find-memory reads the conversation back as a match.
  const importsHome = join(base, "imports-home");
  const transcriptDirectory = join(importsHome, ".claude", "projects", "smoke-project");
  yield* fs.makeDirectory(transcriptDirectory, { recursive: true });
  const conversation = [
    {
      type: "user",
      uuid: "u-1",
      timestamp: "2026-11-13T09:00:00.000Z",
      cwd: project,
      sessionId: "smoke-cc-1",
      message: { role: "user", content: "스모크 회상 기준을 정하자: README가 최상위 문서다" },
    },
    {
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-11-13T09:00:10.000Z",
      cwd: project,
      sessionId: "smoke-cc-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "회상 기준 초안을 notes.md에 적어두겠습니다" }],
      },
    },
  ];
  yield* fs.writeFileString(
    join(transcriptDirectory, "smoke-cc-1.jsonl"),
    `${conversation.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );

  const memoryRun = Effect.fn("smoke.memoryRun")(function* (
    args: readonly string[],
    timeoutMs: number,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(executable, ["memory", ...args], {
            cwd: project,
            env: { CONTEXT_AGENT_BUILD_ID: undefined, CONTEXT_AGENT_DEV_BACKEND: undefined },
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        const collected = yield* Effect.all([
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (all, part) => all + part,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (all, part) => all + part,
            ),
          ),
        ]);
        const code = Number(yield* child.exitCode);
        return { code, out: collected[0], err: collected[1] };
      }),
    ).pipe(Effect.timeout(timeoutMs));
  });
  const jsonLines = (text: string) => text.split("\n").filter((line) => line.trim().length > 0);

  const importRun = yield* memoryRun(
    ["import", "--imports-home", importsHome, "--storage", storage],
    300_000,
  );
  yield* check("memory import exits 0", importRun.code === 0, `exit ${importRun.code}`);
  yield* check(
    "memory import prints one JSON line on stdout",
    jsonLines(importRun.out).length === 1,
    jsonLines(importRun.out).slice(0, 2).join(" ⏎ ").slice(0, 120),
  );
  // The command's contract is one JSON line; the shape below reads only the fields this check
  // needs, and a different shape fails the check through its optional chains.
  // SAFETY: JSON.parse of the line the CLI printed; the asserted shape is what commands print.
  const importJson = yield* Effect.try({
    try: () => JSON.parse(jsonLines(importRun.out)[0] ?? "") as { pass?: { written?: number } },
    catch: (cause) => new Cause.UnknownError(cause),
  });
  yield* check(
    "memory import reports what it wrote",
    (importJson.pass?.written ?? 0) > 0,
    `${importJson.pass?.written ?? "no pass field"} written`,
  );
  yield* check(
    "memory import keeps progress on stderr",
    importRun.err.includes("importing into") && !importRun.out.includes("importing into"),
    importRun.err.slice(0, 80),
  );

  const searchRun = yield* memoryRun(
    ["find-memory", "회상 기준", "--storage", storage, "--project", project],
    60_000,
  );
  yield* check("memory find-memory exits 0", searchRun.code === 0, `exit ${searchRun.code}`);
  yield* check(
    "memory find-memory prints one JSON line on stdout",
    jsonLines(searchRun.out).length === 1,
    jsonLines(searchRun.out).slice(0, 2).join(" ⏎ ").slice(0, 120),
  );
  const searchJson = yield* Effect.try({
    try: () =>
      // SAFETY: JSON.parse of the line the CLI printed; the asserted shape is what find-memory
      // prints, and a different shape fails the check through its optional chains.
      JSON.parse(jsonLines(searchRun.out)[0] ?? "") as {
        matches?: readonly { snippet?: string }[];
      },
    catch: (cause) => new Cause.UnknownError(cause),
  });
  yield* check(
    "memory find-memory matches the imported conversation",
    (searchJson.matches ?? []).some((match) => (match.snippet ?? "").includes("회상 기준")),
    `${(searchJson.matches ?? []).length} matches`,
  );

  if (failures.length > 0) {
    yield* Effect.logError(`${failures.length} check(s) failed`);
    return yield* new Cause.UnknownError(new Error(`${failures.length} smoke checks failed`));
  }
});
await Effect.runPromise(Effect.scoped(program));
