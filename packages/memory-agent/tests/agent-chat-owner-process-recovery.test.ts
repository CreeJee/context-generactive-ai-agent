// Actual child processes and HTTP fetch preserve the owner transport boundary.
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClientRequest, type HttpClientResponse } from "effect/http";
import { testHttpClient } from "./support/http.ts";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  MutableRef,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { bundleScript } from "./support/bundled-script.ts";
import { withTestPlatform } from "./support/platform.ts";
const childFile = new URL("./fixtures/goal-owner-process.mts", import.meta.url);
const childLoader = new URL("./fixtures/native-test-loader.ts", import.meta.url);
/**
 * The owner script bundled once for both tests, so each owner start loads one file instead of
 * type-stripping the whole agent. Its folder links this package as `memory-agent`, where the
 * bundled agent finds its runtime packages and worker scripts, as the app's server bundle does.
 */
class OwnerScript extends Context.Service<OwnerScript, { readonly file: string }>()(
  "memory-agent/tests/agent-chat-owner-process-recovery.test/OwnerScript",
) {
  static readonly layer = Layer.effect(
    OwnerScript,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "agent-owner-script-" });
      yield* fs.makeDirectory(path.join(directory, "node_modules"));
      yield* fs.symlink(
        yield* path.fromFileUrl(new URL("..", import.meta.url)),
        path.join(directory, "node_modules", "memory-agent"),
      );
      const file = yield* bundleScript(
        yield* path.fromFileUrl(childFile),
        path.join(directory, "goal-owner-process.mjs"),
      );
      return { file };
    }),
  ).pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)));
}
const inspection = Schema.Struct({
  bindings: Schema.Array(Schema.Unknown),
  operations: Schema.Array(Schema.Unknown),
  revisions: Schema.Array(Schema.Unknown),
  executions: Schema.Array(Schema.Struct({ runId: Schema.String, status: Schema.String })),
  runs: Schema.Array(Schema.Struct({ status: Schema.String })),
});
type Owner = { child: ChildProcessSpawner.ChildProcessHandle; url: string; sessionId: string };
const inspect = Effect.fn("inspectOwner")(function* (owner: Owner) {
  const response = yield* (yield* testHttpClient())
    .get(`${owner.url}/inspect`)
    .pipe(Effect.timeout("10 seconds"));
  return yield* Schema.decodeUnknownEffect(inspection)(yield* response.json);
});
const kill = Effect.fn("killOwner")(function* (child: ChildProcessSpawner.ChildProcessHandle) {
  if (!(yield* child.isRunning)) return;
  yield* child.kill({ killSignal: "SIGKILL", forceKillAfter: "5 seconds" });
  // The official spawner reports signal termination as a PlatformError rather than an exit code.
  yield* Effect.result(child.exitCode);
  expect(yield* child.isRunning).toBe(false);
});
const Ready = Schema.Struct({ port: Schema.Int, sessionId: Schema.String });
const start = Effect.fn("startOwner")(function* (base: string, mode: string) {
  const path = yield* Path.Path;
  const { file } = yield* OwnerScript;
  const services = yield* Layer.build(NodeChildProcessSpawner.layer);
  const spawner = yield* Effect.provideContext(ChildProcessSpawner.ChildProcessSpawner, services);
  const child = yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        yield* path.fromFileUrl(childLoader),
        file,
        base,
        mode,
      ],
      { stdin: "ignore", killSignal: "SIGKILL" },
    ),
  );
  const diagnostic = MutableRef.make("");
  yield* Effect.forkChild(
    child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        Effect.sync(() => {
          MutableRef.update(diagnostic, (written) => written + text);
        }),
      ),
    ),
    { startImmediately: true },
  );
  const ready = yield* Deferred.make<typeof Ready.Type>();
  yield* Effect.forkChild(
    child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        line.startsWith("OWNER_READY ")
          ? Schema.decodeEffect(Schema.fromJsonString(Ready))(
              line.slice("OWNER_READY ".length),
            ).pipe(
              Effect.flatMap((message) => Deferred.succeed(ready, message)),
              Effect.asVoid,
            )
          : Effect.void,
      ),
    ),
    { startImmediately: true },
  );
  const message = yield* Effect.raceFirst(
    Deferred.await(ready),
    child.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.fail(
          new Cause.UnknownError(new Error(`Owner exited ${code}: ${MutableRef.get(diagnostic)}`)),
        ),
      ),
    ),
  ).pipe(Effect.timeout("15 seconds"));
  return { child, url: `http://127.0.0.1:${message.port}`, sessionId: message.sessionId };
});
/** Starts a run on the owner's chat API, as the page does. */
const post = Effect.fn("postOwner")(function* (owner: Owner, runId: string) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    runId,
    messages: [{ id: `${runId}:user`, role: "user", content: "OS owner recovery" }],
  });
  return yield* (yield* testHttpClient())
    .execute(
      HttpClientRequest.post(`${owner.url}/api/sessions/${owner.sessionId}/runs`).pipe(
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    )
    .pipe(Effect.timeout("10 seconds"));
});
/** Follows a run's events on the owner's chat API from the start. */
const join = Effect.fn("joinOwner")(function* (owner: Owner, runId: string) {
  return yield* (yield* testHttpClient())
    .get(`${owner.url}/api/sessions/${owner.sessionId}/runs/${runId}/events`)
    .pipe(Effect.timeout("10 seconds"));
});
const waitForModel = Effect.fn("waitForOwnerModel")(function* (base: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.repeat(fs.exists(`${base}/model-calls`), {
    until: (ready) => ready,
    schedule: Schedule.spaced("20 millis"),
  }).pipe(Effect.timeout("10 seconds"));
});
const textPrefix = Effect.fn("ownerTextPrefix")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  expect(response.status).toBe(200);
  const chunks = yield* response.stream.pipe(
    Stream.decodeText(),
    Stream.scan(
      () => "",
      (prefix, text) => prefix + text,
    ),
    Stream.takeUntil(
      (prefix) => prefix.includes("completed owner turn") && prefix.endsWith("\n\n"),
    ),
    Stream.runLast,
    Effect.timeout("10 seconds"),
  );
  const prefix = Option.getOrThrow(chunks);
  expect(prefix).toContain("TEXT_MESSAGE_CONTENT");
  expect(prefix).not.toContain("RUN_FINISHED");
  expect(prefix).not.toContain("RUN_ERROR");
  return prefix;
}, Effect.scoped);

layer(OwnerScript.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "real OS owner SIGKILL preserves durable partial text without replaying work",
    () =>
      Effect.scoped(
        withTestPlatform(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const base = yield* fs.makeTempDirectoryScoped({ prefix: "agent-owner-partial-" });

            try {
              const first = yield* start(base, "partial");

              const runId = "partial-killed-run";
              const delivered = yield* textPrefix(yield* post(first, runId));
              const replay = (owner: Owner) => join(owner, runId);
              // A second HTTP reader proves the text is journaled before OS termination.
              expect(yield* textPrefix(yield* replay(first))).toBe(delivered);
              const old = yield* inspect(first);
              expect(old.runs).toHaveLength(1);
              expect(old.bindings).toHaveLength(1);
              const calls = yield* fs.readFileString(path.join(base, "model-calls"));
              expect(calls.trim().split("\n")).toHaveLength(1);
              yield* kill(first.child);
              const second = yield* start(base, "reopen");

              const recovered = yield* inspect(second);
              expect(recovered.bindings).toEqual(old.bindings);
              expect(recovered.revisions).toEqual(old.revisions);
              expect(recovered.operations).toEqual(old.operations);
              expect(recovered.runs).toHaveLength(1);
              expect(recovered.runs[0].status).toBe("failed");
              expect(yield* textPrefix(yield* replay(second))).toBe(delivered);
              expect((yield* post(second, runId)).status).toBe(409);
              expect(yield* inspect(second)).toEqual(recovered);
              expect(yield* fs.readFileString(path.join(base, "model-calls"))).toBe(calls);
            } finally {
            }
          }),
        ),
      ),
    40_000,
  );

  it.effect(
    "real OS owner SIGKILL fences incomplete work",
    () =>
      Effect.scoped(
        withTestPlatform(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const base = yield* fs.makeTempDirectoryScoped({ prefix: "agent-owner-process-" });

            try {
              const first = yield* start(base, "blocked");

              const runId = "killed-run";
              const response = yield* post(first, runId);
              expect(response.status).toBe(200);
              const delivered = yield* Effect.forkChild(
                response.text.pipe(Effect.orElseSucceed(() => "")),
                { startImmediately: true },
              );
              yield* waitForModel(base);
              const old = yield* inspect(first);
              expect(old.bindings).toHaveLength(1);
              yield* kill(first.child);
              yield* Fiber.join(delivered);
              const second = yield* start(base, "reopen");

              const state = yield* inspect(second);
              expect(state.bindings).toEqual(old.bindings);
              expect(state.runs[0].status).toBe("failed");
              const replayResponse = yield* join(second, runId);
              expect(replayResponse.status).toBe(200);
              // A killed SDK log has no terminal chunk: reconnect can deliver its durable
              // prefix but must not be mistaken for a completed stream or awaited to EOF.
              const replay = Option.getOrThrow(
                yield* replayResponse.stream.pipe(
                  Stream.decodeText(),
                  Stream.scan(
                    () => "",
                    (prefix, text) => prefix + text,
                  ),
                  Stream.takeUntil((prefix) => prefix.includes("\n\n")),
                  Stream.runLast,
                ),
              );
              expect(replay).toContain("run.accepted");
              expect(replay).not.toContain("never completed");
              expect(/^id: (.+)$/m.exec(replay)?.[1]).toBeDefined();
              // The killed run never settled; the reopened owner closes its execution.
              expect(old.executions).toEqual([{ runId, status: "suspended" }]);
              expect(state.executions).toEqual([{ runId, status: "completed" }]);
              expect((yield* post(second, runId)).status).toBe(409);
              expect(
                (yield* fs.readFileString(path.join(base, "model-calls"))).trim().split("\n"),
              ).toHaveLength(1);
              // The killed run ran no tool, so a new run continues without replaying it.
              const continued = yield* post(second, "continued-run");
              expect({ status: continued.status, text: yield* continued.text }).toMatchObject({
                status: 200,
                text: expect.stringContaining("completed owner turn"),
              });
              expect(
                (yield* fs.readFileString(path.join(base, "model-calls"))).trim().split("\n"),
              ).toHaveLength(2);
            } finally {
            }
          }),
        ),
      ),
    40_000,
  );
});
