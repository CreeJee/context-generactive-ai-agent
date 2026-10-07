// Actual child processes and HTTP fetch preserve the owner transport boundary.
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { Cause, Effect, Fiber, FileSystem, Option, Path, Schedule, Schema } from "effect";
import { withTestPlatform } from "./support/platform.ts";
const childFile = fileURLToPath(new URL("./fixtures/goal-owner-process.mts", import.meta.url));
const childLoader = fileURLToPath(new URL("./fixtures/native-test-loader.ts", import.meta.url));
const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise(() => Promise.resolve(call()));
const inspection = Schema.Struct({
  bindings: Schema.Array(Schema.Unknown),
  operations: Schema.Array(Schema.Unknown),
  revisions: Schema.Array(Schema.Unknown),
  dispatches: Schema.Array(Schema.Unknown),
  runs: Schema.Array(Schema.Struct({ status: Schema.String })),
});
type Owner = { child: ChildProcess; url: string; sessionId: string };
const inspect = Effect.fn("inspectOwner")(function* (owner: Owner) {
  const response = yield* sdkCall(() =>
    fetch(`${owner.url}/inspect`, { signal: AbortSignal.timeout(10_000) }),
  );
  return yield* Schema.decodeUnknownEffect(inspection)(yield* sdkCall(() => response.json()));
});
const stop = Effect.fn("stopOwner")(function* (child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = yield* Effect.forkChild(
    Effect.callback<void>((resume) => {
      const onExit = () => resume(Effect.void);
      child.once("exit", onExit);
      return Effect.sync(() => {
        child.off("exit", onExit);
      });
    }),
    { startImmediately: true },
  );
  child.kill(signal);
  const settled = yield* Fiber.join(exited).pipe(Effect.timeoutOption("5 seconds"));
  if (Option.isNone(settled)) {
    child.kill("SIGKILL");
    yield* Fiber.join(exited);
  }
});
const Ready = Schema.Struct({ port: Schema.Int, sessionId: Schema.String });
type Ready = typeof Ready.Type;
const start = Effect.fn("startOwner")(function* (base: string, mode: string) {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      fork(childFile, [base, mode], {
        execArgv: ["--experimental-strip-types", "--import", childLoader],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
    ),
    (child) => stop(child, "SIGKILL").pipe(Effect.orDie),
  );
  let diagnostic = "";
  child.stderr?.on("data", (chunk) => {
    diagnostic += String(chunk);
  });
  child.stdout?.resume();
  return yield* Effect.callback<Owner, Cause.UnknownError>((resume) => {
    const onExit = (code: number | null) =>
      resume(Effect.fail(new Cause.UnknownError(new Error(`Owner exited ${code}: ${diagnostic}`))));
    const onReady = (input: Ready) =>
      resume(
        Schema.decodeEffect(Ready)(input).pipe(
          Effect.map((message) => ({
            child,
            url: `http://127.0.0.1:${message.port}`,
            sessionId: message.sessionId,
          })),
          Effect.mapError((cause) => new Cause.UnknownError(cause)),
        ),
      );
    child.once("exit", onExit);
    child.once("message", onReady);
    return Effect.sync(() => {
      child.off("exit", onExit);
      child.off("message", onReady);
    });
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError(
      (cause) =>
        new Cause.UnknownError(new Error(`Owner startup failed: ${diagnostic}`, { cause })),
    ),
  );
});
const post = Effect.fn("postOwner")(function* (owner: Owner, runId: string) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    threadId: owner.sessionId,
    runId,
    messages: [{ id: "user-1", role: "user", content: "OS owner recovery" }],
    tools: [],
    context: [],
  });
  return yield* sdkCall(() =>
    fetch(`${owner.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    }),
  );
});
const waitForModel = Effect.fn("waitForOwnerModel")(function* (base: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.repeat(fs.exists(`${base}/model-calls`), {
    until: (ready) => ready,
    schedule: Schedule.spaced("20 millis"),
  }).pipe(Effect.timeout("10 seconds"));
});
const textPrefix = Effect.fn("ownerTextPrefix")(function* (response: Response) {
  expect(response.status).toBe(200);
  const reader = yield* Effect.acquireRelease(
    Effect.sync(() => response.body!.getReader()),
    (reader) => sdkCall(() => reader.cancel()).pipe(Effect.orDie),
  );
  const decoder = new TextDecoder();
  let prefix = "";
  try {
    while (!prefix.includes("completed owner turn") || !prefix.endsWith("\n\n")) {
      const chunk = yield* sdkCall(() => reader.read());
      if (chunk.done) throw new Error("Stream ended before durable text");
      prefix += decoder.decode(chunk.value, { stream: true });
    }
    expect(prefix).toContain("TEXT_MESSAGE_CONTENT");
    expect(prefix).not.toContain("RUN_FINISHED");
    expect(prefix).not.toContain("RUN_ERROR");
    return prefix;
  } finally {
    yield* sdkCall(() => reader.cancel());
  }
}, Effect.scoped);

it.live(
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
            const replay = Effect.fn("replayOwner")((owner: Owner) =>
              sdkCall(() =>
                fetch(`${owner.url}/api/chat?runId=${runId}&offset=-1`, {
                  signal: AbortSignal.timeout(10_000),
                }),
              ),
            );
            // A second HTTP reader proves the text is journaled before OS termination.
            expect(yield* textPrefix(yield* replay(first))).toBe(delivered);
            const old = yield* inspect(first);
            expect(old.runs).toHaveLength(1);
            expect(old.bindings).toHaveLength(1);
            const calls = yield* fs.readFileString(path.join(base, "model-calls"));
            expect(calls.trim().split("\n")).toHaveLength(1);
            yield* stop(first.child, "SIGKILL");
            const second = yield* start(base, "reopen");

            const recovered = yield* inspect(second);
            expect(recovered.bindings).toEqual(old.bindings);
            expect(recovered.revisions).toEqual(old.revisions);
            expect(recovered.dispatches).toEqual(old.dispatches);
            expect(recovered.operations).toEqual(old.operations);
            expect(recovered.runs).toHaveLength(1);
            expect(recovered.runs[0].status).toBe("failed");
            expect(yield* textPrefix(yield* replay(second))).toBe(delivered);
            for (const retry of [runId, "partial-new-run-bypass"])
              expect((yield* post(second, retry)).status).toBe(409);
            expect(yield* inspect(second)).toEqual(recovered);
            expect(yield* fs.readFileString(path.join(base, "model-calls"))).toBe(calls);
          } finally {
          }
        }),
      ),
    ),
  40_000,
);

for (const interrupted of [false, true]) {
  it.live(
    `real OS owner ${interrupted ? "SIGKILL fences incomplete work" : "SIGTERM preserves completed turn"}`,
    () =>
      Effect.scoped(
        withTestPlatform(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const base = yield* fs.makeTempDirectoryScoped({ prefix: "agent-owner-process-" });

            try {
              const first = yield* start(base, interrupted ? "blocked" : "complete");

              const runId = interrupted ? "killed-run" : "completed-run";
              const response = yield* post(first, runId);
              expect(response.status).toBe(200);
              const delivered = yield* Effect.forkChild(
                sdkCall(() => response.text()).pipe(Effect.orElseSucceed(() => "")),
                { startImmediately: true },
              );
              yield* waitForModel(base);
              let completed = "";
              if (!interrupted) {
                completed = yield* Fiber.join(delivered);
                expect(completed).toContain("completed owner turn");
              }
              const old = yield* inspect(first);
              expect(old.bindings).toHaveLength(1);
              yield* stop(first.child, interrupted ? "SIGKILL" : "SIGTERM");
              yield* Fiber.join(delivered);
              const second = yield* start(base, "reopen");

              const state = yield* inspect(second);
              expect(state.bindings).toEqual(old.bindings);
              expect(state.runs[0].status).toBe(interrupted ? "failed" : "completed");
              const replayResponse = yield* sdkCall(() =>
                fetch(`${second.url}/api/chat?runId=${runId}&offset=-1`, {
                  signal: AbortSignal.timeout(10_000),
                }),
              );
              expect(replayResponse.status).toBe(200);
              // A killed SDK log has no terminal chunk: reconnect can deliver its durable
              // prefix but must not be mistaken for a completed stream or awaited to EOF.
              let replay: string;
              if (interrupted) {
                const reader = replayResponse.body!.getReader();
                const decoder = new TextDecoder();
                replay = "";
                while (!replay.includes("\n\n")) {
                  const chunk = yield* sdkCall(() => reader.read());
                  if (chunk.done) throw new Error("Interrupted log lost its durable prefix");
                  replay += decoder.decode(chunk.value, { stream: true });
                }
                yield* sdkCall(() => reader.cancel());
                expect(replay).toContain("run.accepted");
                expect(replay).not.toContain("never completed");
              } else {
                replay = yield* sdkCall(() => replayResponse.text());
                expect(replay).toBe(completed);
              }
              const firstOffset = /^id: (.+)$/m.exec(replay)?.[1];
              expect(firstOffset).toBeDefined();
              if (!interrupted) {
                const suffix = yield* sdkCall(() =>
                  fetch(`${second.url}/api/chat?runId=${runId}`, {
                    headers: { "Last-Event-ID": firstOffset! },
                    signal: AbortSignal.timeout(10_000),
                  }),
                );
                expect(yield* sdkCall(() => suffix.text())).toBe(
                  replay.slice(replay.indexOf("\n\n") + 2),
                );
              }
              if (interrupted) {
                for (const retry of [runId, "new-run-bypass"])
                  expect((yield* post(second, retry)).status).toBe(409);
              }
              expect(
                (yield* fs.readFileString(path.join(base, "model-calls"))).trim().split("\n"),
              ).toHaveLength(1);
            } finally {
            }
          }),
        ),
      ),
    40_000,
  );
}
