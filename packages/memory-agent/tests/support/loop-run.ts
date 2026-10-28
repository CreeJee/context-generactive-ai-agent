import { Effect, Stream } from "effect";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import { RunFailed, runChat, type RunHook } from "../../src/loop/run.ts";
import {
  scriptedModel,
  scriptedSource,
  type ScriptedTurn,
} from "../../src/testing/scripted-model.ts";
import type { RunTool } from "../../src/tools/run-tool.ts";

/** What a failed scripted model call ends the run with. */
export const modelFailed = "The model failed.";

/**
 * One run of the loop on a model scripted with `turns`, as AgentChat runs a chat: the tools run and
 * the hooks see every step. It returns the run's events and the model's invocations.
 */
export const scriptedRun = Effect.fnUntraced(function* <R = never>(options: {
  readonly turns: readonly [ScriptedTurn, ...Array<ScriptedTurn>];
  readonly runId: string;
  /** The thread the run saves; one of its own when absent. */
  readonly threadId?: string;
  readonly conversation: ReadonlyArray<StoredMessage>;
  readonly tools?: ReadonlyArray<RunTool>;
  readonly hooks?: ReadonlyArray<RunHook<R>>;
}) {
  const { model, invocations } = yield* scriptedModel(options.turns);
  const events = yield* Stream.runCollect(
    runChat(
      {
        model,
        source: scriptedSource,
        system: [],
        tools: options.tools ?? [],
        hooks: options.hooks ?? [],
        modelFailure: () => RunFailed.make({ message: modelFailed }),
      },
      {
        threadId: options.threadId ?? `${options.runId}:thread`,
        runId: options.runId,
        conversation: options.conversation,
        resume: [],
        cancel: Effect.never,
      },
    ),
  );
  return { events, invocations };
});
