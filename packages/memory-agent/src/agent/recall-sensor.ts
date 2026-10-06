import { isTruthy } from "../truthy.ts";
import { MutableHashMap, Cause, Effect, Exit, Option, Schema } from "effect";

/** Optional, shadow-only Laya v0.3.26 System One adapter. No process or model lifecycle here. */
export const layaSensorVersion = "laya-v0.3.26";
const path = "/v1/systemone";
const questionId = "recall_useful";
const maxInputChars = 2048;
const maxResponseBytes = 16_384;
const defaultTimeoutMs = 1500;

export type RecallSensorResult =
  | { readonly status: "evaluated"; readonly version: string; readonly score: number }
  | {
      readonly status: "disabled" | "skipped" | "unavailable" | "timeout" | "cancelled" | "error";
      readonly version: string;
    };

/** `redactedText` must already be minimized and scrubbed by the caller; never pass raw evidence. */
export interface RecallSensorInput {
  readonly turnId: string;
  readonly redactedText: string;
  readonly signal?: AbortSignal;
  /** Resource admission must be decided by the caller; false never invokes the sensor. */
  readonly resourceAllowed?: boolean;
}

class SensorFailed extends Schema.TaggedError<SensorFailed>()("SensorFailed", {}) {}
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
// @effect-diagnostics-next-line schemaSync:off
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

type MockEvaluator = (text: string, signal?: AbortSignal) => Promise<number> | number;
export type RecallSensorConfig =
  | { readonly mode?: "disabled" }
  | { readonly mode: "mock"; readonly evaluate: MockEvaluator; readonly version?: string }
  | {
      readonly mode: "http";
      /** Exact literal loopback URL. Hostnames (including localhost), credentials and redirects are forbidden. */
      readonly endpoint: string;
      readonly timeoutMs?: number;
      readonly fetch?: typeof fetch;
    };

function loopbackEndpoint(value: string): URL | null {
  // Validate the spelling before URL normalization (which accepts numeric/encoded host aliases).
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/v1\/systemone$/.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== path ||
      url.search.length > 0 ||
      url.hash.length > 0
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

const Probability = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.isLessThanOrEqualTo(1)),
);
// Upstream v0.3.26: answers are keyed by question ID. Only `noul` means P(yes).
// Neither confidence nor the ordered score is equivalent to this sensor's value.
const NoulResponse = Schema.Struct({
  answers: Schema.Struct({
    recall_useful: Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
  }),
});
const decodeResponse = Schema.decodeOption(Schema.fromJsonString(NoulResponse));
function validScore(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
// @effect-diagnostics-next-line asyncFunction:off
async function boundedScore(response: Response, signal: AbortSignal): Promise<number | null> {
  if (!(response.body !== null)) throw new Error("empty response");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw new Error("oversized response");
      parts.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const decoded = decodeResponse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return Option.isSome(decoded) ? decoded.value.answers.recall_useful.noul : null;
}

/** Per-run instance: memoizes a turn, including failure, so continuations cannot repeat a call. */
export function createRecallSensor(config: RecallSensorConfig = { mode: "disabled" }) {
  const seen = MutableHashMap.empty<string, Promise<RecallSensorResult>>();
  const version = config.mode === "mock" ? (config.version ?? "mock") : layaSensorVersion;
  const endpoint = config.mode === "http" ? loopbackEndpoint(config.endpoint) : null;

  function evaluate(input: RecallSensorInput): Promise<RecallSensorResult> {
    const previous = Option.getOrUndefined(MutableHashMap.get(seen, input.turnId));
    if (isTruthy(previous)) return previous;
    const outcome = run(input);
    MutableHashMap.set(seen, input.turnId, outcome);
    return outcome;
  }

  function run(input: RecallSensorInput): Promise<RecallSensorResult> {
    const operation = Effect.gen(function* (): Effect.fn.Return<RecallSensorResult, SensorFailed> {
      if (config.mode === undefined || config.mode === "disabled")
        return { status: "disabled", version };
      if (isTruthy(input.signal?.aborted)) return { status: "cancelled", version };
      if (input.resourceAllowed === false || !isTruthy(input.redactedText.trim()))
        return { status: "skipped", version };
      const text = input.redactedText.slice(0, maxInputChars);
      if (config.mode === "mock") {
        const score = yield* Effect.tryPromise({
          try: () => Promise.resolve(config.evaluate(text, input.signal)),
          catch: () => SensorFailed.make({}),
        });
        return validScore(score)
          ? { status: "evaluated", version, score }
          : { status: "error", version };
      }
      if (config.mode !== "http" || endpoint === null) return { status: "unavailable", version };
      const timeoutMs =
        Number.isFinite(config.timeoutMs) && (config.timeoutMs ?? 0) > 0
          ? Math.min(config.timeoutMs!, 30_000)
          : defaultTimeoutMs;
      return yield* Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        // Injected fetch is the loopback protocol boundary; its signal is owned by this fiber.
        const response = yield* Effect.tryPromise({
          try: () =>
            (config.fetch ?? fetch)(endpoint.href, {
              method: "POST",
              redirect: "manual",
              signal,
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: encodeRequest({
                state: text,
                questions: {
                  [questionId]: {
                    type: "noul",
                    instructions:
                      "Would recalling earlier conversation context help answer this turn?",
                  },
                },
                model: "multilingual",
              }),
            }),
          catch: () => SensorFailed.make({}),
        });
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400) ||
          !response.ok
        )
          return yield* SensorFailed.make({});
        const score = yield* Effect.tryPromise({
          try: () => boundedScore(response, signal),
          catch: () => SensorFailed.make({}),
        });
        return score === null
          ? { status: "error" as const, version }
          : { status: "evaluated" as const, version, score };
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.succeed({ status: "timeout" as const, version }),
        }),
      );
    });
    return Effect.runPromiseExit(
      operation,
      input.signal === undefined ? undefined : { signal: input.signal },
    ).then((exit) =>
      Exit.match(exit, {
        onSuccess: (result) => result,
        onFailure: (cause) => ({
          status: Cause.hasInterrupts(cause) ? "cancelled" : "error",
          version,
        }),
      }),
    );
  }
  return { evaluate };
}
