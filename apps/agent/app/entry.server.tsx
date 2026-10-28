import { Cause, Console, Effect, Function as EffectFunction, Schema } from "effect";
import {
  ServerRouter,
  type EntryContext,
  type HandleErrorFunction,
  type RouterContextProvider,
} from "react-router";
import { renderToReadableStream } from "react-dom/server";
import { isbot } from "isbot";

export { configureAgentBackend, disposeAgent } from "./.server/agent.ts";
export const streamTimeout = 5_000;

/** React could not render the document; the renderer's error goes to `handleError`'s log only. */
class DocumentRenderFailed extends Schema.TaggedError<
  DocumentRenderFailed,
  { readonly brand: unique symbol }
>()("DocumentRenderFailed", {
  stage: Schema.Literals(["shell", "all_ready"]),
  cause: Schema.Defect(),
}) {}

/**
 * A loader or action that throws. Node prints an Effect error as its fields without a stack, so
 * the log carries the request and the pretty cause, whose stack shows where it failed.
 */
export const handleError: HandleErrorFunction & {
  (args: Parameters<HandleErrorFunction>[1]): (error: Parameters<HandleErrorFunction>[0]) => void;
} = EffectFunction.dual(
  2,
  (error: Parameters<HandleErrorFunction>[0], { request }: Parameters<HandleErrorFunction>[1]) => {
    if (request.signal.aborted) return;
    // Native stdout/stderr or SDK logging boundary preserves the existing output format.
    Effect.runFork(
      Console.error(
        `[server] ${request.method} ${new URL(request.url).pathname} failed\n${Cause.pretty(Cause.die(error))}`,
      ),
    );
  },
);

// React's Web Stream entry preserves shell/all-ready behavior without a Node pipe adapter.
const renderDocument = Effect.fn("server.renderDocument")(function* (
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
) {
  if (request.method === "HEAD") return new Response(null, { status, headers });
  let shellRendered = false;
  const logError = Effect.runForkWith(yield* Effect.context<never>());
  const body = yield* Effect.tryPromise({
    try: () =>
      renderToReadableStream(<ServerRouter context={context} url={request.url} />, {
        // React owns this deadline after the Response is handed to the HTTP stream owner.
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(streamTimeout + 1_000)]),
        onError(error) {
          status = 500;
          if (shellRendered) logError(Console.error(error));
        },
      }),
    catch: (cause) => DocumentRenderFailed.make({ stage: "shell", cause }),
  });
  shellRendered = true;
  const userAgent = request.headers.get("user-agent");
  if ((userAgent !== null && isbot(userAgent)) || context.isSpaMode)
    yield* Effect.tryPromise({
      try: () => body.allReady,
      catch: (cause) => DocumentRenderFailed.make({ stage: "all_ready", cause }),
    });
  headers.set("Content-Type", "text/html");
  return new Response(body, { status, headers });
});

function handleRequestBody(
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
  _loadContext: RouterContextProvider,
) {
  return Effect.runPromise(renderDocument(request, status, headers, context));
}
const handleRequest: {
  (
    status: number,
    headers: Headers,
    context: EntryContext,
    loadContext: RouterContextProvider,
  ): (request: Request) => Promise<Response>;
} & typeof handleRequestBody = EffectFunction.dual(5, handleRequestBody);
export default handleRequest;
