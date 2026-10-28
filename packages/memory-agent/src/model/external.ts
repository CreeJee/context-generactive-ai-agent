import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  type Cause,
  Effect,
  Match,
  MutableRef,
  Option,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect";
import { AiError, LanguageModel, type Prompt, type Response } from "effect/ai";
import { ExternalPromptOutcome } from "../external-agents/agents.ts";
import type { ShownFailure } from "../providers/contracts.ts";
import { ExternalAgentFailureCode } from "../runtime/shown-failure.ts";
import { optionsKey } from "./prompt.ts";
import { collectResponse } from "./response.ts";
import { shownReason } from "./shown-failure.ts";

/**
 * A conversation held directly with an external ACP agent as an Effect `LanguageModel`, as
 * TanStack's `ExternalAgentAdapter` ran it. The agent keeps its own session and works with its own
 * tools, so a step sends only the user's last words after the memory preamble, streams the agent's
 * text as the answer and lists the tool calls it reported after it.
 */

/**
 * A turn that ended without an answer. The page words `code` and shows `detail`, the agent's own
 * text with secrets already hidden, only under the error's details.
 */
export class ExternalAgentTurnFailed extends Schema.TaggedError<ExternalAgentTurnFailed>()(
  "ExternalAgentTurnFailed",
  { code: ExternalAgentFailureCode, detail: Schema.NullOr(Schema.String) },
) {
  override get message() {
    return this.detail ?? this.code;
  }
}

/** Why a turn did not produce an answer; none when it did. */
export const turnFailure = ExternalPromptOutcome.$match({
  completed: () => Option.none<ExternalAgentTurnFailed>(),
  cancelled: () => Option.none<ExternalAgentTurnFailed>(),
  unavailable: ({ failure }) => Option.some(ExternalAgentTurnFailed.make(failure)),
  failed: ({ failure }) => Option.some(ExternalAgentTurnFailed.make(failure)),
  disconnected: () =>
    Option.some(ExternalAgentTurnFailed.make({ code: "disconnected", detail: null })),
});

type Part = Response.StreamPartEncoded;

const textId = "text-0";

/** The user's words a step answers: the text of the last message when the user sent it. */
const lastUserText = (prompt: Prompt.Prompt) => {
  const last = prompt.content.at(-1);
  return last?.role === "user"
    ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : "";
};

/** The answer one turn streams: the agent's text as it arrives, then the calls it reported. */
const makeAnswer = () => {
  const open = MutableRef.make(false);
  const calls = new Map<string, { readonly title: string; readonly status: string }>();
  const text = (delta: string): Array<Part> => {
    const start: Array<Part> = MutableRef.getAndSet(open, true)
      ? []
      : [{ type: "text-start", id: textId }];
    return [...start, { type: "text-delta", id: textId, delta }];
  };
  /** The parts one session update adds; tool calls are only remembered. */
  const update = Match.type<SessionUpdate>().pipe(
    Match.discriminators("sessionUpdate")({
      agent_message_chunk: ({ content }) => (content.type === "text" ? text(content.text) : []),
      tool_call: (call) => {
        calls.set(call.toolCallId, { title: call.title, status: call.status ?? "pending" });
        return [];
      },
      tool_call_update: (call) => {
        const known = calls.get(call.toolCallId);
        calls.set(call.toolCallId, {
          title: call.title ?? known?.title ?? "",
          status: call.status ?? known?.status ?? "",
        });
        return [];
      },
    }),
    Match.orElse((): Array<Part> => []),
  );
  /** The reported calls after the text, then the end of the answer. */
  const end = (): Array<Part> => {
    const reported =
      calls.size === 0
        ? []
        : text(
            `\n\n외부 에이전트가 알린 도구 호출:\n${[...calls.values()]
              .map((call) => `- ${call.title} (${call.status})`)
              .join("\n")}`,
          );
    return [
      ...reported,
      ...(MutableRef.get(open) ? [{ type: "text-end", id: textId } as const] : []),
      { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
    ];
  };
  return { update, end };
};

// ---------------------------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------------------------

const decodeFailure = Schema.decodeUnknownOption(ExternalAgentTurnFailed);

const aiError = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "ExternalLanguageModel", method: "streamText", reason });

/** Fails with the `AiError` that carries `failure`. */
const failWith = (failure: ExternalAgentTurnFailed) =>
  Schema.encodeEffect(ExternalAgentTurnFailed)(failure).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) =>
      Effect.fail(
        aiError(
          AiError.UnknownError.make({
            description: failure.message,
            metadata: { [optionsKey]: encoded },
          }),
        ),
      ),
    ),
  );

/** The turn failure an `AiError` from an external model carries. */
export const externalFailure = (error: AiError.AiError): Option.Option<ExternalAgentTurnFailed> =>
  Predicate.isTagged(error.reason, "UnknownError")
    ? decodeFailure(error.reason.metadata[optionsKey])
    : Option.none();

/**
 * An external turn's failure as the user sees it: the code the page words with the agent's text
 * under it, or the message of a preamble or turn that rejected, as the SDK showed it.
 */
export const shownExternalFailure = (error: AiError.AiError): ShownFailure =>
  Option.match(externalFailure(error), {
    onSome: (failure) => ({ message: failure.message, code: failure.code }),
    onNone: () =>
      Predicate.isTagged(error.reason, "UnknownError") && error.reason.description !== undefined
        ? { message: error.reason.description }
        : shownReason(error),
  });

/** A preamble or turn that rejected: its message, as the SDK showed the thrown rejection. */
const rejected = (error: Cause.UnknownError) =>
  aiError(
    AiError.UnknownError.make({
      description: Predicate.isError(error.cause) ? error.cause.message : error.message,
    }),
  );

/** External agents answer in their own words: a step that needs JSON is refused unsent. */
const textOnly = (request: LanguageModel.ProviderOptions) =>
  Effect.filterOrFail(
    Effect.succeed(request.responseFormat),
    (format) => format.type !== "json",
    () =>
      aiError(
        AiError.InvalidRequestError.make({
          description: "External agents do not produce separate structured output.",
        }),
      ),
  );

/** One conversation's external agent: the agent and its session stay fixed for every step. */
export interface ExternalModelOptions {
  /** The agent's name: the model its answers are stored under. */
  readonly agent: string;
  /** Sends one user turn; interrupting it cancels the turn. Updates arrive through `onUpdate`. */
  readonly turn: (
    text: string,
    onUpdate: (update: SessionUpdate) => void,
  ) => Effect.Effect<ExternalPromptOutcome, Cause.UnknownError>;
  /** Leads the prompt: relevant memory and how to treat it. */
  readonly preamble: (text: string) => Effect.Effect<string, Cause.UnknownError>;
}

export const externalModel = ({ agent, turn, preamble }: ExternalModelOptions) => {
  const streamText = (request: LanguageModel.ProviderOptions) =>
    Stream.callback<Part, AiError.AiError>((queue) =>
      Effect.gen(function* () {
        yield* textOnly(request);
        const answer = makeAnswer();
        const text = lastUserText(request.prompt);
        Queue.offerUnsafe(queue, { type: "response-metadata", modelId: agent });
        const outcome = yield* turn(`${yield* preamble(text)}${text}`, (update) => {
          Queue.offerAllUnsafe(queue, answer.update(update));
        });
        yield* Option.match(turnFailure(outcome), { onNone: () => Effect.void, onSome: failWith });
        Queue.offerAllUnsafe(queue, answer.end());
        yield* Queue.end(queue);
      }).pipe(Effect.catchTag("UnknownError", (error) => Effect.fail(rejected(error)))),
    );
  return LanguageModel.make({
    streamText,
    generateText: (request) => collectResponse(streamText(request)),
  });
};
