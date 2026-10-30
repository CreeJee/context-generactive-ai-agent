import { Array as Arr, Effect, Option } from "effect";
import type { StoredMessage } from "../chat-store/schema.ts";
import type { RunHook, RunScope, StepRequest } from "../loop/run.ts";

/**
 * An automatic run (a task completion, a Plan's next step, the kanban board) starts with no user
 * turn, so its conversation ends on the last answer, and Anthropic refuses a request that ends on
 * an assistant message. Why the run started goes to the model as a user turn right after the
 * message the run started from, as Claude Code sends a `<task-notification>`. Every step of the run
 * sends it in the same place; only the request holds it, so the thread and the page never do.
 */
export const followupTurnHook = (
  texts: ReadonlyArray<string>,
  startedAfter: StoredMessage | undefined,
) => {
  const turn: StoredMessage = {
    role: "user",
    content: [
      { type: "text", content: `<system-reminder>\n${texts.join("\n\n")}\n</system-reminder>` },
    ],
  };
  // A history that no longer holds that message, such as one compaction cut, gets the turn last.
  const placed = (history: ReadonlyArray<StoredMessage>) =>
    Option.match(
      Option.flatMap(Option.fromNullishOr(startedAfter?.id), (id) =>
        Arr.findLastIndex(history, (message) => message.id === id),
      ),
      {
        onSome: (index) => [...history.slice(0, index + 1), turn, ...history.slice(index + 1)],
        onNone: () => [...history, turn],
      },
    );
  return {
    request: (_scope: RunScope, request: StepRequest) =>
      Effect.succeed({ ...request, history: placed(request.history) }),
  } satisfies RunHook;
};
