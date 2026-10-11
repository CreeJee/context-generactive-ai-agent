import { it } from "@effect/vitest";
import { Cause, Deferred, Effect } from "effect";
import { describe, expect, vi } from "vite-plus/test";
import {
  createLocalRecallSensor,
  type LocalLayaResponse,
  type LocalLayaSession,
} from "../src/agent/recall-sensor-local.ts";

const answer: LocalLayaResponse = { answers: { recall_useful: { type: "noul", noul: 0.7 } } };
const input = { turnId: "one", redactedText: "redacted turn" };
const sdkCall = Effect.fn("localRecallTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
// The SDK mock must return the same native Promise until its explicitly released completion.
const gate = Effect.fn("localRecallTest.gate")(function* <T>() {
  const deferred = yield* Deferred.make<T>();
  const run = Effect.runPromiseWith(yield* Effect.context());
  return {
    promise: run(Deferred.await(deferred)),
    resolve: (value: T) => Deferred.doneUnsafe(deferred, Effect.succeed(value)),
  };
});
function setup(
  systemOne = vi.fn<LocalLayaSession["systemOne"]>().mockResolvedValue(answer),
  timeoutMs = 1500,
  modelDir = "/local/model",
) {
  const close = vi.fn<LocalLayaSession["close"]>().mockResolvedValue(undefined);
  const load = vi.fn().mockResolvedValue({ systemOne, close });
  const sensor = createLocalRecallSensor({ mode: "local", modelDir, loader: { load }, timeoutMs });
  return { sensor, load, close, systemOne };
}
describe("prepared local recall sensor", () => {
  it.live("defaults off and skips resource-denied requests before loading", () =>
    Effect.gen(function* () {
      const disabled = createLocalRecallSensor();
      expect((yield* sdkCall(() => disabled.evaluate(input))).status).toBe("disabled");
      yield* sdkCall(() => disabled.close());
      const test = setup();
      expect(
        (yield* sdkCall(() => test.sensor.evaluate({ ...input, resourceAllowed: false }))).status,
      ).toBe("skipped");
      expect(test.load).not.toHaveBeenCalled();
      yield* sdkCall(() => test.sensor.close());
    }),
  );
  it.live.each(["", "relative/model", "   "])(
    "rejects invalid modelDir %j before loading",
    (modelDir) =>
      Effect.gen(function* () {
        const test = setup(undefined, 1500, modelDir);
        expect((yield* sdkCall(() => test.sensor.evaluate(input))).status).toBe("unavailable");
        expect(test.load).not.toHaveBeenCalled();
        yield* sdkCall(() => test.sensor.close());
      }),
  );
  it.live(
    "loads local CPU options, bounds text, deduplicates the current turn and closes once",
    () =>
      Effect.gen(function* () {
        const test = setup();
        const first = test.sensor.evaluate({ ...input, redactedText: "x".repeat(3000) });
        expect(test.sensor.evaluate(input)).toBe(first);
        expect(yield* sdkCall(() => first)).toMatchObject({ status: "evaluated", score: 0.7 });
        expect(test.load).toHaveBeenCalledWith({
          modelDir: "/local/model",
          executionProviders: ["cpu"],
          sessionOptions: { intraOpNumThreads: 2 },
        });
        expect(test.systemOne.mock.calls[0]![0]).toEqual({
          state: "x".repeat(2048),
          questions: { recall_useful: { type: "noul", instructions: expect.any(String) } },
        });
        yield* sdkCall(() => test.sensor.evaluate({ ...input, turnId: "two" }));
        expect(test.load).toHaveBeenCalledTimes(1);
        yield* sdkCall(() => test.sensor.close());
        yield* sdkCall(() => test.sensor.close());
        expect(test.close).toHaveBeenCalledTimes(1);
        expect((yield* sdkCall(() => test.sensor.evaluate(input))).status).toBe("unavailable");
      }),
  );
  it.live.each([
    {},
    { answers: { recall_useful: { type: "noul", noul: 2 } } },
    { answers: { recall_useful: { type: "confidence", noul: 0.7 } } },
  ])("validates keyed noul output", (output) =>
    Effect.gen(function* () {
      // Deliberately violate the SDK contract to verify the runtime trust boundary.
      const test = setup(
        // SAFETY: Test-only malformed SDK output; the adapter's Schema must reject it before use.
        vi.fn<LocalLayaSession["systemOne"]>().mockResolvedValue(output as LocalLayaResponse),
      );
      expect((yield* sdkCall(() => test.sensor.evaluate(input))).status).toBe("error");
      yield* sdkCall(() => test.sensor.close());
    }),
  );
  it.live("maps SDK errors safely and releases loaded sessions", () =>
    Effect.gen(function* () {
      const test = setup(vi.fn().mockRejectedValue(new Error("private content")));
      expect((yield* sdkCall(() => test.sensor.evaluate(input))).status).toBe("error");
      yield* sdkCall(() => test.sensor.close());
      expect(test.close).toHaveBeenCalledTimes(1);
      const failedLoad = setup();
      failedLoad.load.mockRejectedValue(new Error("private path"));
      expect((yield* sdkCall(() => failedLoad.sensor.evaluate(input))).status).toBe("error");
      yield* sdkCall(() => failedLoad.sensor.close());
      expect(failedLoad.close).not.toHaveBeenCalled();
    }),
  );
  it.live.each(["timeout", "cancelled"] as const)(
    "%s drains native work before settling or closing, without overlap",
    (status) => {
      const controller = new AbortController();
      return Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const started = yield* gate<void>();
          const native = yield* gate<LocalLayaResponse>();
          const systemOne = vi.fn(() => {
            started.resolve();
            return native.promise;
          });
          const test = setup(systemOne, 10);

          let settled = false;
          const pending = test.sensor.evaluate({ ...input, signal: controller.signal });
          void pending.then(() => {
            settled = true;
          });
          yield* sdkCall(() => started.promise);
          if (status === "cancelled") controller.abort();
          else yield* sdkCall(() => vi.advanceTimersByTimeAsync(20));
          expect(settled).toBe(false);
          expect(
            (yield* sdkCall(() => test.sensor.evaluate({ ...input, turnId: "two" }))).status,
          ).toBe("skipped");
          const closing = test.sensor.close();
          expect(test.close).not.toHaveBeenCalled();
          native.resolve(answer);
          expect((yield* sdkCall(() => pending)).status).toBe(status);
          yield* sdkCall(() => closing);
          expect(test.close).toHaveBeenCalledTimes(1);
          expect(systemOne).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });
    },
  );
});
