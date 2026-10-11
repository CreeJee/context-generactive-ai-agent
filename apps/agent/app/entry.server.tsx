import { Cause, Console, Effect, Function as EffectFunction } from "effect";
import { ServerRouter, type EntryContext, type RouterContextProvider } from "react-router";
import { renderToReadableStream } from "react-dom/server";
import { isbot } from "isbot";

export { configureAgentBackend, disposeAgent } from "./.server/agent.ts";
export const streamTimeout = 5_000;

// React's Web Stream entry preserves shell/all-ready behavior without a Node pipe adapter.
const renderDocument = Effect.fn("server.renderDocument")(function* (
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
) {
  if (request.method === "HEAD") return new Response(null, { status, headers });
  let shellRendered = false;
  const logError = Effect.runSyncWith(yield* Effect.context<never>());
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
    catch: (cause) => new Cause.UnknownError(cause),
  });
  shellRendered = true;
  const userAgent = request.headers.get("user-agent");
  if ((userAgent !== null && isbot(userAgent)) || context.isSpaMode)
    yield* Effect.promise(() => body.allReady);
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
