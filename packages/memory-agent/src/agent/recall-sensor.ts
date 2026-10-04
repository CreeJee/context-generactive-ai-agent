import { Option, Schema } from "effect";

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
      url.username ||
      url.password ||
      url.pathname !== path ||
      url.search ||
      url.hash
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
function validScore(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

async function boundedScore(response: Response): Promise<number | null> {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
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
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const decoded = Schema.decodeUnknownOption(NoulResponse)(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  return Option.isSome(decoded) ? decoded.value.answers.recall_useful.noul : null;
}

/** Per-run instance: memoizes a turn, including failure, so continuations cannot repeat a call. */
export function createRecallSensor(config: RecallSensorConfig = { mode: "disabled" }) {
  const seen = new Map<string, Promise<RecallSensorResult>>();
  const version = config.mode === "mock" ? (config.version ?? "mock") : layaSensorVersion;
  const endpoint = config.mode === "http" ? loopbackEndpoint(config.endpoint) : null;

  async function evaluate(input: RecallSensorInput): Promise<RecallSensorResult> {
    const previous = seen.get(input.turnId);
    if (previous) return previous;
    const outcome = run(input);
    seen.set(input.turnId, outcome);
    return outcome;
  }

  async function run(input: RecallSensorInput): Promise<RecallSensorResult> {
    if (config.mode === undefined || config.mode === "disabled")
      return { status: "disabled", version };
    if (input.signal?.aborted) return { status: "cancelled", version };
    if (input.resourceAllowed === false || !input.redactedText.trim())
      return { status: "skipped", version };
    if (config.mode === "http" && !endpoint) return { status: "unavailable", version };
    const text = input.redactedText.slice(0, maxInputChars);
    if (config.mode === "mock") {
      try {
        const score = await config.evaluate(text, input.signal);
        if (input.signal?.aborted) return { status: "cancelled", version };
        return validScore(score)
          ? { status: "evaluated", version, score }
          : { status: "error", version };
      } catch {
        return { status: input.signal?.aborted ? "cancelled" : "error", version };
      }
    }
    if (config.mode !== "http" || !endpoint) return { status: "unavailable", version };
    const controller = new AbortController();
    let timedOut = false;
    let rejectAbort: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const cancel = () => {
      controller.abort();
      rejectAbort?.(new Error("cancelled"));
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    const timeoutMs =
      Number.isFinite(config.timeoutMs) && (config.timeoutMs ?? 0) > 0
        ? Math.min(config.timeoutMs!, 30_000)
        : defaultTimeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    try {
      if (input.signal?.aborted) return { status: "cancelled", version };
      const request = async () => {
        const response = await (config.fetch ?? fetch)(endpoint.href, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            state: text,
            questions: {
              [questionId]: {
                type: "noul",
                instructions: "Would recalling earlier conversation context help answer this turn?",
              },
            },
            model: "multilingual",
          }),
        });
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400) ||
          !response.ok
        )
          throw new Error("bad response");
        return boundedScore(response);
      };
      const score = await Promise.race([request(), aborted]);
      if (input.signal?.aborted) return { status: "cancelled", version };
      if (timedOut) return { status: "timeout", version };
      return score === null
        ? { status: "error", version }
        : { status: "evaluated", version, score };
    } catch {
      return {
        status: input.signal?.aborted ? "cancelled" : timedOut ? "timeout" : "error",
        version,
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
  return { evaluate };
}
