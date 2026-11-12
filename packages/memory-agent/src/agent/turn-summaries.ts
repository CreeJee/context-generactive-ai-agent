import { isTruthy } from "../truthy.ts";
import { Semaphore } from "effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Cause, Context, Effect, Layer, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { ActiveProvider } from "../providers/active-provider.ts";
import { AuthConnectionState } from "../providers/contracts.ts";
import { Nodes } from "../memory/nodes.ts";
import { GlobalConfig } from "../config/global-config.ts";
import { defaultSummaryStartPercent } from "./compaction-policy.ts";
import { ApiUsage } from "./api-usage.ts";
import { fallbackLogged, logDefect } from "../runtime/logged-failures.ts";
import type { RunHook } from "../loop/run.ts";
import { finishedRun, RunStore } from "../loop/store.ts";
import {
  compactionStateEffect,
  summarizeEarlierTurns,
  summaryWriter,
  type CompactionSources,
  type SummaryOutcome,
} from "./compaction.ts";
import { sessionSummarizer } from "./session-summary.ts";

export class TurnSummaryFailed extends Schema.TaggedError<
  TurnSummaryFailed,
  { readonly brand: unique symbol }
>()("TurnSummaryFailed", {
  operation: Schema.Literals(["load-messages", "load-state"]),
  cause: Schema.optional(Schema.Defect()),
}) {}

const summaryFailed =
  (operation: TurnSummaryFailed["operation"]) =>
  <E>(cause: E) =>
    TurnSummaryFailed.make({ operation, cause });

const make = Effect.fnUntraced(function* (automatic: boolean) {
  const scope = yield* Effect.scope;
  const nodes = yield* Nodes;
  const runStore = yield* RunStore;
  const active = yield* ActiveProvider;
  const usageLedger = yield* ApiUsage;
  const crypto = yield* SecureRandom.SecureRandom;
  const config = yield* GlobalConfig;
  const oneAtATime = yield* Semaphore.make(1);
  const startPercent = Effect.map(
    config.read,
    (settings) => settings.summaryStartPercent ?? defaultSummaryStartPercent,
  );

  /**
   * Writes the session's summary on through the turns before the latest few, which are always sent
   * as they are, or for `/compact` (`whole`) whatever the size. Otherwise only once what the
   * conversation sends fills the configured share of the model's context window: once it has a
   * summary it keeps it, so the request prefix stays stable. A saved conversation that does not
   * match what memory recorded (an imported one, say) is left alone.
   */
  const catchUp = (sessionId: string, whole: boolean): Effect.Effect<SummaryOutcome> =>
    Effect.gen(function* () {
      const selection = yield* active.selected;
      if (!isTruthy(selection)) return "unavailable" as const;
      const auth = yield* active.auth(selection);
      if (!AuthConnectionState.$is("signed-in")(auth)) return "unavailable" as const;

      const messages = yield* Effect.mapError(
        runStore.thread(sessionId),
        summaryFailed("load-messages"),
      );
      const state = yield* Effect.mapError(
        compactionStateEffect({ metadata: runStore.chatMetadata, threadId: sessionId }),
        summaryFailed("load-state"),
      );
      const sources: CompactionSources = {
        toolResultIds: (toolCallIds) => nodes.toolResultIds(sessionId, toolCallIds),
        nodeTexts: nodes.texts,
        userMessages: nodes.userMessages(sessionId),
      };
      const runtime = yield* active.runtime(selection);
      const percent = yield* startPercent;
      const reached = yield* summarizeEarlierTurns({
        messages,
        state,
        sources,
        writer: summaryWriter({
          metadata: runStore.chatMetadata,
          threadId: sessionId,
          summarize: sessionSummarizer({
            services: { active, usageLedger, crypto },
            rootSessionId: sessionId,
            selection,
          }),
        }),
        threshold: Option.liftPredicate(
          (runtime.contextWindow(selection.model) * percent) / 100,
          () => !whole,
        ),
      });
      return reached ? ("done" as const) : ("failed" as const);
    }).pipe(
      // What was summarized before the failure is kept; the rest is tried again next time.
      fallbackLogged("Turn summaries stopped", () => "failed" as const),
      oneAtATime.withPermits(1),
    );

  // Retried after the next run; a failure here never reaches the conversation.
  const inBackground = (sessionId: string) =>
    Effect.catchDefect(catchUp(sessionId, false), (defect) =>
      logDefect("Turn summaries stopped")(Cause.die(defect)),
    ).pipe(Effect.forkIn(scope), Effect.when(Effect.succeed(automatic)), Effect.asVoid);

  return {
    catchUp,

    /** The share of the context window, in percent, at which summarizing starts. */
    startPercent,
    setStartPercent: (percent: number) =>
      Effect.as(config.update({ summaryStartPercent: percent }), percent),

    /**
     * Summarizes in the background once a run has finished, so the next run starts from the
     * summary. A run that failed or was cancelled starts none.
     */
    hookFor: (sessionId: string): RunHook => ({
      ended: (_scope, end) =>
        Effect.when(inBackground(sessionId), Effect.succeed(finishedRun(end))).pipe(Effect.asVoid),
    }),
  };
});

/** The session's summary of its earlier turns, written after its runs. */
export class TurnSummaries extends Context.Service<
  TurnSummaries,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/agent/turn-summaries/TurnSummaries") {
  static readonly layerNoDeps = (automatic = true) => Layer.effect(TurnSummaries, make(automatic));
  static readonly layer = (automatic = true) =>
    TurnSummaries.layerNoDeps(automatic).pipe(Layer.provide(NodeCrypto.layer));
}
