import { Effect, Stream } from "effect";
import type { AgentModelRuntime, ModelSelection } from "../providers/contracts.ts";
import { toPrompt } from "./prompt.ts";

/**
 * The app's single model calls on Effect AI (docs/effect-ai-migration.md step 7): permission
 * review, report diagnosis, interpretation and turn summaries ask one question under one system
 * prompt, with no tools and no history.
 */
export interface SingleCall {
  readonly runtime: AgentModelRuntime;
  readonly selection: ModelSelection;
  /** A fresh id for this call alone, so no prompt cache or account pin outlives it. */
  readonly threadId: string;
  readonly system: string;
  readonly prompt: string;
}

/** The call's model, kept until its scope closes. */
const modelOf = ({ runtime, selection, threadId }: SingleCall) =>
  Effect.map(
    runtime.model(selection, { threadId, runId: threadId, cacheRetention: "none" }),
    ({ model }) => model,
  );

const promptOf = ({ system, prompt }: SingleCall) =>
  toPrompt([{ role: "user", content: prompt }], [system]);

/** The whole answer, with the usage the provider reported. */
export const singleAnswer = Effect.fn("singleAnswer")(function* (call: SingleCall) {
  const model = yield* modelOf(call);
  return yield* model.generateText({ prompt: promptOf(call) });
}, Effect.scoped);

/** The answer's parts as the provider streams them, so silence can be told from a long answer. */
export const singleAnswerParts = (call: SingleCall) =>
  Stream.unwrap(Effect.map(modelOf(call), (model) => model.streamText({ prompt: promptOf(call) })));
