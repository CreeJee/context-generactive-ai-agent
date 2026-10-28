import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientError,
  HttpBody,
} from "effect/http";
import {
  Effect,
  MutableHashSet,
  Function as EffectFunction,
  ManagedRuntime,
  Scope,
  Exit,
  Stream,
  Cause,
} from "effect";
import { Schema } from "effect";

const BackendRestartBody = Schema.Struct({
  error: Schema.Literals(["backend_restart_required", "backend_restarting"]),
});

let restartRequired = false;
const listeners = MutableHashSet.empty<() => void>();

const markBackendRestartRequired = () => {
  if (restartRequired) return;
  restartRequired = true;
  for (const listener of listeners) listener();
};

const requiresRestart = (response: Response) =>
  response.ok
    ? Effect.succeed(false)
    : Effect.tryPromise(() => response.clone().json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(BackendRestartBody)),
        Effect.as(true),
        // Any other failed response, JSON or not, is the caller's to handle.
        Effect.catchTags({
          UnknownError: () => Effect.succeed(false),
          SchemaError: () => Effect.succeed(false),
        }),
      );
export const responseRequiresBackendRestart = (response: Response) =>
  Effect.runPromise(requiresRestart(response));

const observeBackendRestart = (response: Response) =>
  requiresRestart(response).pipe(
    Effect.tap((required) =>
      Effect.sync(() => {
        if (required) markBackendRestartRequired();
      }),
    ),
    Effect.as(response),
  );
class BackendTransportFailed extends Schema.TaggedError<
  BackendTransportFailed,
  { readonly brand: unique symbol }
>()("BackendTransportFailed", { cause: Schema.Defect() }) {}

/** Pin requests to the backend used to build this client; never retry a rejected mutation. */
export const backendFetch: {
  (
    origin: string,
    transport: typeof fetch,
  ): (buildId: string) => ReturnType<typeof backendFetchBody>;
} & typeof backendFetchBody = EffectFunction.dual(3, backendFetchBody);
function backendFetchBody(buildId: string, origin: string, transport: typeof fetch): typeof fetch {
  return (input, init) =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () => {
          const url = new URL(input instanceof Request ? input.url : String(input), origin);
          if (buildId.length > 0 && url.origin === origin && url.pathname.startsWith("/api/")) {
            const headers = new Headers(
              init?.headers ?? (input instanceof Request ? input.headers : undefined),
            );
            headers.set("x-context-agent-build-id", buildId);
            return transport(input, { ...init, headers });
          }
          return transport(input, init);
        },
        catch: (cause) => BackendTransportFailed.make({ cause }),
      }).pipe(Effect.flatMap(observeBackendRestart)),
    );
}

const transportRuntime = ManagedRuntime.make(FetchHttpClient.layer);
/** The SDK consumes native Response bodies, while HttpClient owns the request and cancellation. */
const sdkHttpTransport: typeof fetch = (input, init) => {
  const baseUrl =
    typeof document !== "undefined"
      ? document.baseURI
      : typeof location !== "undefined"
        ? location.href
        : typeof window !== "undefined"
          ? window.location.href
          : undefined;
  const request = new Request(
    input instanceof Request ? input : new URL(String(input), baseUrl),
    init,
  );
  const scope = Scope.makeUnsafe();
  const close = () => transportRuntime.runPromise(Scope.close(scope, Exit.void));
  const abort = () => {
    void close();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  const release = Scope.close(scope, Exit.void).pipe(
    Effect.ensuring(Effect.sync(() => request.signal.removeEventListener("abort", abort))),
  );
  return transportRuntime
    .runPromiseExit(
      Effect.gen(function* () {
        const client = HttpClient.withScope(yield* HttpClient.HttpClient);
        let outgoing = HttpClientRequest.fromWeb(request);
        if (request.body !== null && !(init?.body instanceof ReadableStream)) {
          // fromWeb exposes every native body as a stream. Browser streaming uploads require
          // HTTP/2 and break ordinary JSON POSTs to our HTTP/1.1 dev proxy.
          const original = init?.body;
          if (original !== undefined && original !== null && !(original instanceof FormData)) {
            outgoing = HttpClientRequest.setBody(
              outgoing,
              HttpBody.raw(original, {
                contentType: request.headers.get("content-type") ?? undefined,
              }),
            );
          } else {
            // A Request/FormData has already fixed its encoding and multipart boundary.
            const bytes = yield* Effect.tryPromise(() => request.arrayBuffer());
            outgoing = HttpClientRequest.bodyUint8Array(
              outgoing,
              new Uint8Array(bytes),
              request.headers.get("content-type") ?? undefined,
            );
          }
        }
        const response = yield* client.execute(outgoing);
        const bodyless = request.method === "HEAD" || [204, 205, 304].includes(response.status);
        const body = bodyless
          ? null
          : yield* Stream.toReadableStreamEffect(response.stream.pipe(Stream.ensuring(release)));
        if (bodyless) yield* release;
        return new Response(body, { status: response.status, headers: response.headers });
      }).pipe(
        Scope.provide(scope),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.provideService(FetchHttpClient.RequestInit, {
          cache: request.cache,
          credentials: request.credentials,
          integrity: request.integrity,
          keepalive: request.keepalive,
          mode: request.mode,
          redirect: request.redirect,
          referrer: request.referrer,
          referrerPolicy: request.referrerPolicy,
        }),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? release : Effect.void)),
      ),
      { signal: request.signal },
    )
    .then(
      Exit.match({
        onSuccess: (response) => response,
        onFailure: (cause) => {
          const error = Cause.squash(cause);
          return Promise.reject(
            HttpClientError.isHttpClientError(error) &&
              error.reason instanceof HttpClientError.TransportError
              ? error.reason.cause
              : error,
          );
        },
      }),
    );
};

/** Includes direct backend browsing and the chat SSE transport. */
export const appFetch: {
  (init?: RequestInit): (input: RequestInfo | URL) => Promise<Response>;
} & typeof fetch = EffectFunction.dual(
  (args) =>
    args[0] instanceof URL || args[0] instanceof Request || Schema.is(Schema.String)(args[0]),
  appFetchBody,
);
function appFetchBody(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const arguments_: Parameters<typeof fetch> = [input, init];
  return typeof window === "undefined"
    ? // Native Request/Response adapter preserves host and SDK stream semantics.
      sdkHttpTransport(...arguments_)
    : backendFetch(
        import.meta.env.VITE_CONTEXT_AGENT_BUILD_ID ?? "",
        window.location.origin,
        sdkHttpTransport,
      )(...arguments_);
}

export const subscribeBackendRestart = (listener: () => void) => {
  MutableHashSet.add(listeners, listener);
  return () => MutableHashSet.remove(listeners, listener);
};

export const backendRestartSnapshot = () => restartRequired;
