import { nativeFailure, nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { runOAuthNodeEffect } from "../oauth/node-runtime.ts";
import { Crypto, FileSystem, Path } from "effect";
import { DateTime, Effect, Function, Result, Schema } from "effect";

export interface CompatibleTraceIdentity {
  readonly threadId?: string | undefined;
  readonly runId?: string | undefined;
}

type TraceEvent =
  | { kind: "headers"; status: number; headers: Record<string, string> }
  | { kind: "chunk"; bytes: number; totalBytes: number }
  | {
      kind: "completed" | "cancelled" | "failed";
      phase: "headers" | "body";
      bytes: number;
      savedBytes: number;
      chunks: number;
      truncated: boolean;
      codes: string[];
    };
const hasTransportCode = Schema.is(
  Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[A-Z0-9_]+$/)) }),
);

const responseHeaderNames = [
  "content-type",
  "content-length",
  "transfer-encoding",
  "x-request-id",
  "x-litellm-call-id",
  "x-litellm-version",
  "x-litellm-response-duration-ms",
];
const rawLimit = 32 * 1024 * 1024;

function errorCodes(cause: unknown): string[] {
  const codes: string[] = [];
  const seen: unknown[] = [];
  while (cause instanceof Error && !seen.includes(cause) && seen.length < 8) {
    seen.push(cause);
    if (hasTransportCode(cause)) codes.push(cause.code);
    cause = cause.cause;
  }
  return codes;
}

/** SDK fetch boundary: capture only bytes consumed by the caller, without a tee or background reader. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function traceCompatibleResponse(options: {
  readonly directory: string;
  readonly identity: CompatibleTraceIdentity & {
    readonly adapterId: string;
    readonly sequence: number;
  };
  readonly request: () => Promise<Response>;
  readonly signal?: AbortSignal | undefined;
}) {
  return traceCompatibleResponseBody(
    options.directory,
    options.identity,
    options.request,
    options.signal,
  );
}
function traceCompatibleResponseBody(
  directory: string,
  identity: CompatibleTraceIdentity & { readonly adapterId: string; readonly sequence: number },
  request: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  return runOAuthNodeEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const requestId = yield* crypto.randomUUIDv4();
      const startedAt = DateTime.formatIso(DateTime.nowUnsafe());
      const started = performance.now();
      const prefix = path.join(directory, `${startedAt.replace(/[:.]/g, "-")}-${requestId}`);
      let recording = true;
      let bytes = 0;
      let savedBytes = 0;
      let chunks = 0;
      let ended = false;
      let cancelled = false;
      // A diagnostic disk failure must be visible, but must not replace the transport result.
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      const save = <A, E>(operation: Effect.Effect<A, E>) =>
        Effect.suspend(() =>
          !recording
            ? Effect.void
            : operation.pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    recording = false;
                    yield* Effect.logError("Compatible response trace write failed", {
                      requestId,
                      codes: errorCodes(nativeFailure(cause).cause),
                    });
                  }),
                ),
              ),
        );
      const encodeJson = Function.flow(
        Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
        Result.getOrThrow,
      );
      const event = (value: TraceEvent) =>
        save(
          fs.writeFileString(
            `${prefix}.jsonl`,
            encodeJson({ ...value, elapsedMs: performance.now() - started }) + "\n",
            { flag: "a" },
          ),
        );
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      const finish = Effect.fn("CompatibleTrace.finish")(function* (
        kind: "completed" | "cancelled" | "failed",
        phase: "headers" | "body",
        cause?: unknown,
      ) {
        if (ended) return;
        ended = true;
        yield* event({
          kind,
          phase,
          bytes,
          savedBytes,
          chunks,
          truncated: bytes > savedBytes,
          codes: errorCodes(cause),
        });
      });
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      yield* save(
        Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          yield* fs.writeFileString(
            `${prefix}.jsonl`,
            encodeJson({ kind: "started", requestId, startedAt, ...identity }) + "\n",
            { mode: 0o600, flag: "wx" },
          );
          yield* fs.writeFile(`${prefix}.raw`, new Uint8Array(), { mode: 0o600, flag: "wx" });
        }),
      );
      const response = yield* nativePromise(request).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* finish(
              signal?.aborted === true ? "cancelled" : "failed",
              "headers",
              error.cause,
            );
            return yield* error;
          }),
        ),
      );
      yield* event({
        kind: "headers",
        status: response.status,
        headers: Object.fromEntries(
          responseHeaderNames.flatMap((name) => {
            const value = response.headers.get(name);
            return value === null ? [] : [[name, value]];
          }),
        ),
      });
      if (!(response.body !== null)) {
        yield* finish("completed", "body");
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
          pull: (controller) =>
            runNativeEffect(
              Effect.gen(function* () {
                const next = yield* nativePromise(() => reader.read());
                if (cancelled) return;
                if (next.done) {
                  yield* finish("completed", "body");
                  reader.releaseLock();
                  controller.close();
                  return;
                }
                bytes += next.value.byteLength;
                chunks++;
                const raw = next.value.subarray(0, Math.max(0, rawLimit - savedBytes));
                yield* save(fs.writeFile(`${prefix}.raw`, raw, { flag: "a" }));
                if (recording) savedBytes += raw.byteLength;
                yield* event({ kind: "chunk", bytes: next.value.byteLength, totalBytes: bytes });
                controller.enqueue(next.value);
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    if (cancelled) return;
                    const error = nativeFailure(cause).cause;
                    yield* finish(signal?.aborted === true ? "cancelled" : "failed", "body", error);
                    reader.releaseLock();
                    controller.error(error);
                  }),
                ),
              ),
            ),
          cancel: (reason) =>
            runNativeEffect(
              Effect.gen(function* () {
                cancelled = true;
                yield* finish("cancelled", "body", reason);
                yield* nativePromise(() => reader.cancel(reason)).pipe(
                  Effect.ensuring(Effect.sync(() => reader.releaseLock())),
                );
              }),
            ),
        },
        { highWaterMark: 0 },
      );
      const traced = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      for (const name of ["url", "redirected", "type"] as const)
        Object.defineProperty(traced, name, { value: response[name] });
      return traced;
    }),
  );
}
