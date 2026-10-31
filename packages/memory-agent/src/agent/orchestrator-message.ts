import { DateTime, Effect, HashSet } from "effect";
import type { OrchestratorNote, StoredUserMessage } from "../chat-store/schema.ts";
import type { ParentNotificationView } from "../work-trace/store.ts";

/** Notification kinds that report a task's end. */
const endKinds = HashSet.fromIterable(["completed", "failed", "stopped", "interrupted"]);

/** The tasks whose end `notifications` report, the background tasks apart from the subagents. */
export const endedTasks = (
  notifications: ReadonlyArray<ParentNotificationView>,
): OrchestratorNote["ended"] => {
  const ended = notifications.filter(({ kind }) => HashSet.has(endKinds, kind));
  const background = ended.filter(
    ({ agentName }) => agentName?.startsWith("background_") === true,
  ).length;
  return { background, subagent: ended.length - background };
};

/**
 * The message the orchestrator sends to start an automatic run: a task's end, the Plan's next step
 * or the kanban board. The thread keeps it and the page shows it as the orchestrator's. The model
 * reads it as a user turn, so the conversation never ends on the last answer, which Anthropic
 * refuses as a prefill. It is never a user node, so it authorizes nothing the user must.
 */
export const orchestratorMessage = (
  id: string,
  note: OrchestratorNote,
  texts: ReadonlyArray<string>,
) =>
  Effect.map(DateTime.now, (now): typeof StoredUserMessage.Type => ({
    role: "user",
    id,
    createdAt: DateTime.formatIso(now),
    content: `<orchestrator>\n${[
      "The app's orchestrator sent this message, not the user.",
      ...texts,
    ].join("\n\n")}\n</orchestrator>`,
    orchestrator: note,
  }));
