import { chatParamsFromRequestBody, toServerSentEventsResponse } from "@tanstack/ai";
import { AuthConnectionState } from "../providers/contracts.ts";
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence";
import { Cause, Context, Effect, Layer, Option, Stream } from "effect";
import { failureTags } from "../runtime/logged-failures.ts";
import { incomingUserTurn } from "../agent/chat.ts";
import { createChatExecution } from "../agent/chat-execution.ts";
import { withShownRunErrors } from "../agent/run-errors.ts";
import { repeatGuard } from "../tools/repeat-guard.ts";
import { createLiveRuns } from "../agent/live-runs.ts";
import { Attachments } from "../attachments/attachments.ts";
import { modelImages } from "../attachments/model-images.ts";
import { attachmentIdOf } from "../attachments/urls.ts";
import { GlobalConfig } from "../config/global-config.ts";
import { Graph } from "../memory/graph.ts";
import { Interpretations } from "../memory/interpretations.ts";
import { KnowledgePromotions } from "../memory/knowledge.ts";
import { Nodes } from "../memory/nodes.ts";
import { MemorySearch } from "../memory/search.ts";
import { isEmptyUserText } from "../messages/empty-user.ts";
import { ActiveProvider } from "../providers/active-provider.ts";
import { compatibleToolCalling } from "../providers/openai-compatible-config.ts";
import { releaseSubscriptionRun } from "../providers/subscription-runtime.ts";
import { SdkCancellations } from "../runtime/sdk-cancellation.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { btwInstructions, parentConversationPrompt } from "./context.ts";
import { BtwError, BtwRunInProgress, BtwStorageFailed } from "./contracts.ts";
import { runTrace } from "../runtime/run-trace.ts";
import { BtwThreads } from "./store.ts";
import { btwEvidenceTools, btwToolGuard } from "./tools.ts";

const json = <T>(status: number, body: T): Response => Response.json(body, { status });

const make = Effect.gen(function* () {
  const threads = yield* BtwThreads;
  const nodes = yield* Nodes;
  const attachments = yield* Attachments;
  const active = yield* ActiveProvider;
  const config = yield* GlobalConfig;
  const redactor = yield* SecretRedactor;
  const memory = yield* Effect.all({
    search: MemorySearch,
    nodes: Nodes,
    graph: Graph,
    interpretations: Interpretations,
    knowledge: KnowledgePromotions,
  });
  const liveRuns = yield* createLiveRuns;
  const cancellations = yield* SdkCancellations;
  const runEffect = Effect.runPromiseWith(yield* Effect.context());

  /**
   * One BTW question. The main conversation is read fresh for this request; the answer, its tool
   * calls and results are saved only to the BTW thread. No recorder, indexer, interpreter,
   * summarizer, usage ledger or promotion middleware takes part.
   */
  const handle = Effect.fnUntraced(function* (request: Request, threadId: string) {
    const thread = yield* threads.get(threadId);
    if (liveRuns.get(threadId) !== null) return json(409, { error: "run_in_progress" });
    const selection = yield* active.selected;
    const auth = yield* active.authFor(selection?.provider ?? (yield* active.provider));
    if (AuthConnectionState.$is("error")(auth))
      return json(503, { error: "provider_auth_unavailable", provider: auth.provider });
    if (!AuthConnectionState.$is("signed-in")(auth)) return json(401, { error: "login_required" });
    if (selection === null) return json(412, { error: "model_selection_required" });

    const params = yield* Effect.tryPromise(() => request.json()).pipe(
      Effect.flatMap((body) => Effect.tryPromise(() => chatParamsFromRequestBody(body))),
      Effect.asSome,
      Effect.catchTag("UnknownError", () => Effect.succeedNone),
    );
    if (Option.isNone(params)) return json(400, { error: "invalid_chat_request" });
    const { messages, runId, parentRunId } = params.value;
    // A BTW turn is always a new question: there are no approvals or client tools to continue.
    const last = messages.at(-1);
    const turn = last !== undefined ? Option.getOrNull(incomingUserTurn(last)) : null;
    if (turn === null || last === undefined) return json(400, { error: "user_turn_required" });
    if (isEmptyUserText(last)) return json(400, { error: "empty_message" });
    const images = yield* Effect.forEach(turn.imageUrls, (url) => {
      const id = attachmentIdOf(url);
      return id !== null ? attachments.get(id) : Effect.succeed(null);
    });
    if (images.includes(null)) return json(400, { error: "unknown_attachment" });
    const attached = images.filter((image) => image !== null);
    if (attached.length > 0) {
      const readsImages = yield* Effect.flatMap(active.models(selection), (models) =>
        models.acceptsImages(selection.model),
      ).pipe(
        // Unknown model capabilities are answered as no images, as for a model without them.
        Effect.catch((error) =>
          Effect.as(
            Effect.logDebug("btw_model_capabilities_unavailable", {
              error: failureTags(Cause.fail(error)),
            }),
            false,
          ),
        ),
      );
      if (!readsImages) return json(422, { error: "images_not_supported", model: selection.model });
    }

    const toolCalling =
      selection.provider !== "openai-compatible" ||
      compatibleToolCalling(yield* config.read, selection.model);
    const runtime = yield* active.runtime(selection);
    yield* threads.link(
      threadId,
      attached.map((attachment) => attachment.id),
    );
    // Not tied to the request: closing the panel keeps the answer running until it is saved.
    // Only an explicit delete or the service shutting down cancels it.
    const parentConversation = parentConversationPrompt(
      yield* nodes.session(thread.parentSessionId),
    );
    const adapter = runtime.adapter(selection);
    const cancellation = yield* cancellations.allocate("service_shutdown");
    const abortController = cancellation.controller;
    const claim = yield* liveRuns.claim(
      threadId,
      runId,
      abortController,
      () => releaseSubscriptionRun(adapter),
      cancellation.release,
      cancellation.cancel,
    );
    if (claim === null) {
      releaseSubscriptionRun(adapter);
      yield* cancellation.release;
      return json(409, { error: "run_in_progress" });
    }
    // Tool calls run on this request's context, so their spans join `BtwChat.handle`'s trace.
    const caller = yield* runTrace;
    const stream = withShownRunErrors(
      redactor,
      createChatExecution<typeof adapter>().execute(
        {
          messages,
          threadId,
          runId,
          parentRunId,
          systemPrompts: [btwInstructions, parentConversation],
        },
        {
          model: { adapter, agentLoopStrategy: runtime.agentLoop },
          tools: toolCalling
            ? redactor.withHiddenResults(btwEvidenceTools({ ...memory, caller }, thread.projectId))
            : [],
          middleware: [
            withPersistence(threads.persistence),
            btwToolGuard,
            repeatGuard(),
            modelImages(attachments, runEffect),
            runtime.runMiddleware(),
          ],
          stream: { abortController },
        },
      ),
    );
    const published = yield* cancellation.publish(stream);
    return toServerSentEventsResponse(Stream.toAsyncIterable(claim.track(published)), {
      abortController,
    });
    // The span is applied here, not by `Effect.fn`, so the type knows the tools' run span exists.
  }, Effect.withSpan("BtwChat.handle"));

  return {
    handle,

    /** GET for a reopened BTW panel: the saved transcript of this thread only. */
    hydrate: Effect.fn("BtwChat.hydrate")(function* (request: Request, threadId: string) {
      yield* threads.get(threadId);
      return yield* Effect.tryPromise({
        try: () =>
          reconstructChat(threads.persistence, request, {
            authorize: (requested) => Promise.resolve(requested === threadId),
          }),
        catch: () =>
          BtwError.make({ reason: BtwStorageFailed.make({ operation: "read_transcript" }) }),
      });
    }),

    create: threads.create,
    list: threads.list,

    /** Explicit delete: stops a running answer first so it cannot save into a removed thread. */
    remove: Effect.fn("BtwChat.remove")(function* (threadId: string) {
      yield* threads.get(threadId);
      const live = liveRuns.get(threadId);
      if (live !== null) {
        yield* live.cancel;
        yield* live.ended;
      }
      if (liveRuns.get(threadId) !== null)
        return yield* BtwError.make({ reason: BtwRunInProgress.make({ threadId }) });
      yield* threads.remove(threadId);
    }),
  };
});

/** BTW side questions: read the main conversation and project memory, write nothing back. */
export class BtwChat extends Context.Service<BtwChat, Effect.Success<typeof make>>()(
  "memory-agent/btw/chat/BtwChat",
) {
  static readonly layer = Layer.effect(BtwChat, make).pipe(
    Layer.provide(SdkCancellations.layer),
    Layer.provideMerge(BtwThreads.layer),
  );
}
