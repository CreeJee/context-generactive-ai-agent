import {
  Array as Arr,
  Cause,
  Context,
  Crypto,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Queue,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { BtwQuestion, Refusal } from "../api/chat-api.ts";
import { AuthConnectionState } from "../providers/contracts.ts";
import { failureTags } from "../runtime/logged-failures.ts";
import { withPageTurns } from "../agent/page-turns.ts";
import { shownRunErrors } from "../agent/run-errors.ts";
import { repeatGuardHook } from "../tools/repeat-guard.ts";
import { createLiveRuns } from "../agent/live-runs.ts";
import { Attachments } from "../attachments/attachments.ts";
import { modelImagesHook } from "../attachments/model-images.ts";
import { attachmentIdOf } from "../attachments/urls.ts";
import type { StoredMessage } from "../chat-store/schema.ts";
import { shownMessage } from "../chat-state/snapshot.ts";
import { GlobalConfig } from "../config/global-config.ts";
import type { AgUiEvent } from "../loop/chunks.ts";
import { modelFailureOf, runChat } from "../loop/run.ts";
import { RunStore } from "../loop/store.ts";
import { Graph } from "../memory/graph.ts";
import { Interpretations } from "../memory/interpretations.ts";
import { KnowledgePromotions } from "../memory/knowledge.ts";
import { Nodes } from "../memory/nodes.ts";
import { MemorySearch } from "../memory/search.ts";
import { isEmptyUserText } from "../messages/empty-user.ts";
import { ActiveProvider } from "../providers/active-provider.ts";
import { compatibleToolCalling } from "../providers/openai-compatible-config.ts";
import { aborted } from "../runtime/aborted.ts";
import { RunCancellations } from "../runtime/run-cancellation.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { btwInstructions, parentConversationPrompt } from "./context.ts";
import { BtwError, BtwRunInProgress } from "./contracts.ts";
import { BtwThreads } from "./store.ts";
import { btwEvidenceRunTools, btwToolGuardHook } from "./tools.ts";

const isText = Schema.is(Schema.String);
const isUrlImage = Schema.is(
  Schema.Struct({
    type: Schema.Literal("image"),
    source: Schema.Struct({ type: Schema.Literal("url"), value: Schema.String }),
  }),
);

/** The images a question shows by URL; an image sent inline names no attachment. */
const imageUrls = (content: BtwQuestion["message"]["content"]) =>
  isText(content) ? [] : content.filter(isUrlImage).map(({ source }) => source.value);

/** A BTW answer's events, or why its question was refused. */
type Asked = Result.Result<Stream.Stream<AgUiEvent>, Refusal>;

type NamedMessage = StoredMessage & { readonly id: string };

/** Messages the panel shows as one. */
interface ShownGroup {
  readonly id: string;
  readonly messages: Arr.NonEmptyReadonlyArray<StoredMessage>;
}

interface Grouping {
  readonly groups: ReadonlyArray<ShownGroup>;
  /** The last group is an answer, which its later steps and tool results join. */
  readonly answering: boolean;
}

/** Whether `message` belongs to `answer`: a later step of it, or a tool result. */
const continues = (answer: ShownGroup, message: NamedMessage) =>
  Match.value(message).pipe(
    Match.discriminatorsExhaustive("role")({
      user: () => false,
      assistant: ({ id }) => id === answer.id || id.startsWith(`${answer.id}-segment-`),
      tool: () => true,
    }),
  );

/**
 * The messages grouped as the panel shows them, as TanStack's `modelMessagesToUIMessages` grouped
 * them for it: an answer holds its steps and tool results until the next question.
 */
const grouped = (messages: ReadonlyArray<NamedMessage>) =>
  messages.reduce<Grouping>(
    (state, message) =>
      Option.match(
        Option.filter(
          Arr.last(state.groups),
          (last) => state.answering && continues(last, message),
        ),
        {
          onSome: (answer) => ({
            groups: [
              ...state.groups.slice(0, -1),
              { ...answer, messages: Arr.append(answer.messages, message) },
            ],
            answering: true,
          }),
          onNone: () => ({
            groups: [...state.groups, { id: message.id, messages: Arr.of(message) }],
            answering: message.role === "assistant",
          }),
        },
      ),
    { groups: [], answering: false },
  ).groups;

const make = Effect.gen(function* () {
  const threads = yield* BtwThreads;
  const nodes = yield* Nodes;
  const attachments = yield* Attachments;
  const active = yield* ActiveProvider;
  const config = yield* GlobalConfig;
  const redactor = yield* SecretRedactor;
  const runStore = yield* RunStore;
  const crypto = yield* Crypto.Crypto;
  const memory = yield* Effect.all({
    search: MemorySearch,
    nodes: Nodes,
    graph: Graph,
    interpretations: Interpretations,
    knowledge: KnowledgePromotions,
  });
  const liveRuns = yield* createLiveRuns;
  const cancellations = yield* RunCancellations;
  // A BTW answer outlives the request that asked it, but not this service.
  const scope = yield* Effect.scope;

  /**
   * The loop's store for a BTW thread: its transcript is `btw_threads.messages`, and a BTW run
   * leaves no run, interrupt or metadata row.
   */
  const btwStore = RunStore.of({
    ...runStore,
    thread: threads.messages,
    saveThread: threads.saveMessages,
    startRun: () => Effect.succeedNone,
    endRun: () => Effect.void,
    pendingInterrupts: () => Effect.succeed([]),
    createInterrupts: () => Effect.void,
    commitInterrupts: () => Effect.void,
  });

  const refused = (refusal: Refusal): Asked => Result.fail(refusal);
  const answered = (events: Stream.Stream<AgUiEvent>): Asked => Result.succeed(events);

  /**
   * One BTW question. The main conversation is read fresh for this request; the answer, its tool
   * calls and results are saved only to the BTW thread. No recorder, indexer, interpreter,
   * summarizer, usage ledger or promotion hook takes part.
   */
  const ask = Effect.fn("BtwChat.ask")(function* (threadId: string, question: BtwQuestion) {
    const thread = yield* threads.get(threadId);
    if ((yield* liveRuns.get(threadId)) !== null) return refused({ error: "run_in_progress" });
    const selection = yield* active.selected;
    const auth = yield* active.authFor(selection?.provider ?? (yield* active.provider));
    if (AuthConnectionState.$is("error")(auth))
      return refused({ error: "provider_auth_unavailable", provider: auth.provider });
    if (!AuthConnectionState.$is("signed-in")(auth)) return refused({ error: "login_required" });
    if (selection === null) return refused({ error: "model_selection_required" });
    if (isEmptyUserText(question.message)) return refused({ error: "empty_message" });

    const images = yield* Effect.forEach(imageUrls(question.message.content), (url) =>
      Option.match(Option.fromNullishOr(attachmentIdOf(url)), {
        onNone: () => Effect.succeed(null),
        onSome: attachments.get,
      }),
    );
    if (images.includes(null)) return refused({ error: "unknown_attachment" });
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
      if (!readsImages) return refused({ error: "images_not_supported", model: selection.model });
    }

    const toolCalling =
      selection.provider !== "openai-compatible" ||
      compatibleToolCalling(yield* config.read, selection.model);
    const system = [
      btwInstructions,
      parentConversationPrompt(yield* nodes.session(thread.parentSessionId)),
    ];
    const hooks = [btwToolGuardHook, yield* repeatGuardHook, modelImagesHook(attachments)];
    const conversation = withPageTurns(yield* threads.messages(threadId), [question.message]);
    const runtime = yield* active.runtime(selection);
    yield* threads.link(
      threadId,
      attached.map((attachment) => attachment.id),
    );
    // What the model pins for the run, such as an account, is let go when the run ends.
    const modelScope = yield* Scope.make();
    const runModel = yield* runtime
      .model(selection, { threadId, runId: question.runId, cacheRetention: "none" })
      .pipe(Effect.provideService(Scope.Scope, modelScope));
    // Only an explicit delete or the service shutting down cancels the answer.
    const cancellation = yield* cancellations.allocate("service_shutdown");
    const released = Effect.andThen(cancellation.release, Scope.close(modelScope, Exit.void));
    const claim = yield* liveRuns.claim({
      sessionId: threadId,
      runId: question.runId,
      controller: cancellation.controller,
      releaseResources: released,
    });
    if (claim === null) {
      yield* released;
      return refused({ error: "run_in_progress" });
    }
    const events = runChat(
      {
        model: runModel.model,
        source: runModel.source,
        system,
        tools: toolCalling
          ? redactor.withHiddenResults(
              btwEvidenceRunTools({ env: memory, projectId: thread.projectId }),
            )
          : [],
        hooks,
        modelFailure: modelFailureOf(runModel.shownFailure),
      },
      {
        threadId,
        runId: question.runId,
        conversation,
        resume: [],
        cancel: aborted(cancellation.controller.signal),
      },
    ).pipe(
      shownRunErrors(redactor),
      Stream.provideService(RunStore, btwStore),
      Stream.provideService(Crypto.Crypto, crypto),
    );
    // The panel reads the events while it is open; closing it leaves the answer running.
    const read = yield* Queue.unbounded<AgUiEvent, Cause.Done>();
    yield* Effect.forkIn(Effect.ensuring(Stream.runIntoQueue(events, read), claim.release), scope, {
      startImmediately: true,
    });
    return answered(Stream.fromQueue(read));
  });

  return {
    ask,

    /** The thread's messages as the panel shows them, oldest first. */
    messages: Effect.fn("BtwChat.messages")(function* (threadId: string) {
      yield* threads.get(threadId);
      const stored = yield* threads.messages(threadId);
      return grouped(
        stored.map((message, index) => ({
          ...message,
          id: message.id ?? `btw:${threadId}:${index}`,
        })),
      ).map(shownMessage);
    }),

    create: threads.create,
    list: threads.list,

    /** Explicit delete: stops a running answer first so it cannot save into a removed thread. */
    remove: Effect.fn("BtwChat.remove")(function* (threadId: string) {
      yield* threads.get(threadId);
      yield* Option.match(Option.fromNullishOr(yield* liveRuns.get(threadId)), {
        onNone: () => Effect.void,
        onSome: (live) => Effect.andThen(live.cancel, live.ended),
      });
      yield* Effect.when(
        Effect.fail(BtwError.make({ reason: BtwRunInProgress.make({ threadId }) })),
        Effect.map(liveRuns.get(threadId), (live) => live !== null),
      );
      yield* threads.remove(threadId);
    }),
  };
});

/** BTW side questions: read the main conversation and project memory, write nothing back. */
export class BtwChat extends Context.Service<BtwChat, Effect.Success<typeof make>>()(
  "memory-agent/btw/chat/BtwChat",
) {
  static readonly layer = Layer.effect(BtwChat, make).pipe(
    Layer.provide(RunCancellations.layer),
    Layer.provideMerge(BtwThreads.layer),
  );
}
