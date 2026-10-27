import { Effect, Predicate, Stream } from "effect";
import { AiError, Prompt, type LanguageModel, type Tool } from "effect/ai";
import { subscriptionBody } from "../src/model/subscription.ts";
import type { ModelSelection, RunModel } from "../src/providers/contracts.ts";
import { estimateRequestTokens, type RequestTokenEstimate } from "./request-token-budget.ts";

/** One request a paid pilot's model is about to send. */
export interface PilotRequest {
  readonly selection: ModelSelection;
  readonly prompt: Prompt.Prompt;
  readonly tools: ReadonlyArray<Tool.Any>;
  /**
   * The whole serialized subscription request, tool schemas included. A local BPE count, only a
   * preflight guard: billed and cached usage come from the provider.
   */
  readonly estimate: RequestTokenEstimate;
}

/** Stops a pilot's request before the provider gets it; the run fails with `description`. */
export const pilotStopped = (description: string) =>
  AiError.make({
    module: "PilotGuard",
    method: "streamText",
    reason: AiError.UnknownError.make({ description }),
  });

type Options = Parameters<LanguageModel.LanguageModel["streamText"]>[0];

const toolsOf = (toolkit: Options["toolkit"]): ReadonlyArray<Tool.Any> =>
  Predicate.hasProperty(toolkit, "tools") && Predicate.isObject(toolkit.tools)
    ? // SAFETY: the loop passes a `Toolkit`, whose `tools` holds its tools by name.
      Object.values(toolkit.tools as Record<string, Tool.Any>)
    : [];

/**
 * A run's subscription model that hands each request to `check` before the provider gets it,
 * summary and other single calls included. `check` fails to stop the request, or gives the prompt
 * to send.
 */
export const pilotGuarded =
  (
    selection: ModelSelection,
    check: (request: PilotRequest) => Effect.Effect<Prompt.Prompt, AiError.AiError>,
  ) =>
  (run: RunModel): RunModel => {
    const checked = <O extends Pick<Options, "prompt" | "toolkit">>(options: O) =>
      Effect.gen(function* () {
        if (selection.provider === "openai-compatible")
          return yield* pilotStopped("subscription_pilot_only");
        const prompt = Prompt.make(options.prompt);
        const tools = toolsOf(options.toolkit);
        const estimate = estimateRequestTokens(
          subscriptionBody({
            provider: selection.provider,
            selection,
            prompt,
            tools,
            promptCache: undefined,
          }),
          selection.model,
        );
        return { ...options, prompt: yield* check({ selection, prompt, tools, estimate }) };
      });
    return {
      ...run,
      model: {
        ...run.model,
        // SAFETY: the request goes on as it came, with the prompt `check` gave.
        streamText: ((options: Options) =>
          Stream.unwrap(
            Effect.map(checked(options), run.model.streamText),
          )) as LanguageModel.LanguageModel["streamText"],
        // SAFETY: as `streamText`.
        generateText: ((options: Parameters<LanguageModel.LanguageModel["generateText"]>[0]) =>
          Effect.flatMap(
            checked(options),
            run.model.generateText,
          )) as LanguageModel.LanguageModel["generateText"],
      },
    };
  };
