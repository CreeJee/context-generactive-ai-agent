import {
  Array as Arr,
  Effect,
  HashSet,
  Match,
  Option,
  Order,
  Predicate,
  Result,
  Schema,
} from "effect";
import { StoredInterruptResponse } from "../chat-store/schema.ts";
import { JsonValue } from "../json.ts";
import { jsonSchemaIssues } from "../tools/input-repair.ts";
import { InterruptAnswer, type PendingInterrupt } from "./store.ts";

/**
 * The answers a resume run brings to the interrupts its thread waits on
 * (docs/effect-ai-migration.md "interrupt 재개 handshake"). They are checked before the run starts,
 * in the order and with the codes and texts TanStack used, so the page reads the same refusals. A
 * refused resume starts no run and changes nothing.
 */

/** One answer as the page sent it; its status and payload are checked here. */
export const ResumeEntry = Schema.Struct({
  interruptId: Schema.String,
  status: Schema.String,
  payload: Schema.optionalKey(JsonValue),
});
export type ResumeEntry = typeof ResumeEntry.Type;

/** A resume the pending interrupts refuse; `message` is what the page shows. */
export class ResumeRejected extends Schema.TaggedError<
  ResumeRejected,
  { readonly brand: unique symbol }
>()("ResumeRejected", {
  code: Schema.String,
  message: Schema.String,
}) {}

/** A pending interrupt and the answer the resume gives it. */
export interface Resumed {
  readonly interrupt: PendingInterrupt;
  readonly answer: InterruptAnswer;
}

const incomplete = (code: string, item: string) =>
  ResumeRejected.make({
    code,
    message: `${item} Resume entries must resolve or cancel the complete interrupt batch.`,
  });

const isStatus = Schema.is(Schema.Literals(["resolved", "cancelled"]));

/** The batch answers each pending interrupt of one run once, and nothing else. */
const checkBatch = Effect.fnUntraced(function* (
  pending: ReadonlyArray<PendingInterrupt>,
  resume: ReadonlyArray<ResumeEntry>,
  entryOf: (interruptId: string) => Option.Option<ResumeEntry>,
) {
  if (HashSet.size(HashSet.fromIterable(pending.map(({ runId }) => runId))) > 1)
    return yield* ResumeRejected.make({
      code: "stale",
      message: "Thread has pending interrupts from more than one run.",
    });
  const duplicate = Arr.findFirst(
    resume,
    ({ interruptId }, index) =>
      resume.findIndex((other) => other.interruptId === interruptId) !== index,
  );
  if (Option.isSome(duplicate))
    return yield* incomplete(
      "conflict",
      `Interrupt ${duplicate.value.interruptId} has duplicate resume entries.`,
    );
  if (pending.length > 0 && resume.length === 0)
    return yield* incomplete(
      "unknown-interrupt",
      "Thread has pending interrupts; resume is required before accepting new input.",
    );
  yield* Effect.forEach(
    pending,
    ({ interruptId }) =>
      Option.match(entryOf(interruptId), {
        onNone: () =>
          Effect.fail(
            incomplete(
              "unknown-interrupt",
              `Missing resume entry for pending interrupt ${interruptId}.`,
            ),
          ),
        onSome: ({ status }) =>
          Effect.when(
            Effect.fail(
              incomplete(
                "unknown-interrupt",
                `Invalid resume status for pending interrupt ${interruptId}: ${status}.`,
              ),
            ),
            Effect.succeed(!isStatus(status)),
          ),
      }),
    { discard: true },
  );
  const pendingIds = HashSet.fromIterable(pending.map(({ interruptId }) => interruptId));
  yield* Effect.forEach(
    resume,
    ({ interruptId }) =>
      Effect.when(
        Effect.fail(
          incomplete(
            "unknown-interrupt",
            `Resume entry references non-pending interrupt ${interruptId}.`,
          ),
        ),
        Effect.succeed(!HashSet.has(pendingIds, interruptId)),
      ),
    { discard: true },
  );
});

const decodeResponse = Schema.decodeUnknownOption(StoredInterruptResponse);
/** An approval's decision carried in an object; its other fields are the schema's to check. */
const decodeDecision = Schema.decodeUnknownOption(Schema.Struct({ approved: Schema.Boolean }));
const decodeSchema = Schema.decodeUnknownOption(Schema.Record(Schema.String, JsonValue));

/**
 * The response `payload` gives, checked against the interrupt's own response schema and then the
 * stored response shape.
 */
const checkedResponse = (
  schema: JsonValue,
  payload: JsonValue,
  invalid: string,
): Result.Result<typeof StoredInterruptResponse.Type, ReadonlyArray<string>> =>
  Option.match(
    Option.flatMap(decodeSchema(schema), (readable) =>
      jsonSchemaIssues({ schema: readable, value: payload }),
    ),
    {
      onSome: (issues) => Result.fail(issues.map((issue) => `${invalid}: ${issue}`)),
      onNone: () => Result.fromOption(decodeResponse(payload), () => [`${invalid}.`]),
    },
  );

/** What a resolved approval says: a boolean, or an object deciding in `approved`. */
const approvalResponse = (interruptId: string, schema: JsonValue, payload: JsonValue) =>
  Predicate.isBoolean(payload)
    ? Result.succeed<typeof StoredInterruptResponse.Type>(
        payload ? { approved: true } : { approved: false },
      )
    : Option.match(decodeDecision(payload), {
        onNone: () =>
          Result.fail([`Approval ${interruptId} must be a boolean or decision envelope.`]),
        onSome: () =>
          checkedResponse(schema, payload, `Approval ${interruptId} envelope is invalid`),
      });

/** The answer an entry gives its interrupt, or what is wrong with its payload. */
const answerOf = (
  { interruptId, payload: asked }: PendingInterrupt,
  { status, payload }: ResumeEntry,
): Result.Result<InterruptAnswer, ReadonlyArray<string>> =>
  status === "cancelled"
    ? payload === undefined
      ? Result.succeed(InterruptAnswer.Cancelled({ interruptId }))
      : Result.fail([`Cancelled interrupt ${interruptId} must not include a payload.`])
    : Result.map(
        Match.value(asked).pipe(
          Match.discriminatorsExhaustive("reason")({
            tool_call: ({ responseSchema }) =>
              approvalResponse(interruptId, responseSchema, payload ?? null),
            permission_review: ({ responseSchema }) =>
              checkedResponse(
                responseSchema,
                payload ?? null,
                `Interrupt ${interruptId} payload is invalid`,
              ),
          }),
        ),
        (response) => InterruptAnswer.Resolved({ interruptId, response }),
      );

const byInterruptId = Order.mapInput(
  Order.String,
  ([interrupt]: readonly [PendingInterrupt, unknown]) => interrupt.interruptId,
);

/**
 * The answers `resume` gives the thread's `pending` interrupts, in their order. A batch that does
 * not answer exactly those interrupts, or answers one wrongly, is refused whole.
 */
export const resumeAnswers = Effect.fnUntraced(function* (
  pending: ReadonlyArray<PendingInterrupt>,
  resume: ReadonlyArray<ResumeEntry>,
): Effect.fn.Return<ReadonlyArray<Resumed>, ResumeRejected> {
  const entryOf = (interruptId: string) =>
    Arr.findFirst(resume, (entry) => entry.interruptId === interruptId);
  yield* checkBatch(pending, resume, entryOf);
  // Every pending interrupt has its entry now.
  const answered = pending.flatMap((interrupt) =>
    Option.toArray(
      Option.map(
        entryOf(interrupt.interruptId),
        (entry) => [interrupt, answerOf(interrupt, entry)] as const,
      ),
    ),
  );
  // TanStack listed the problems by interrupt id.
  const problems = Arr.sort(answered, byInterruptId).flatMap(([, answer]) =>
    Result.match(answer, { onFailure: (messages) => messages, onSuccess: () => [] }),
  );
  if (problems.length > 0)
    return yield* ResumeRejected.make({
      code: "invalid-payload",
      message: [...problems, "One or more interrupt resolutions are invalid."].join(" "),
    });
  return answered.flatMap(([interrupt, answer]) =>
    Result.match(answer, {
      onFailure: () => [],
      onSuccess: (answer): ReadonlyArray<Resumed> => [{ interrupt, answer }],
    }),
  );
});
