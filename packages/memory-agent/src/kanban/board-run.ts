/**
 * Run ids of the runs the kanban board starts: its own loop, card agents and verifiers. They begin
 * with `kanban:` and the Goal, so a task under one is the board's, not one the chat started.
 */
export const boardRunId = (goalInstanceId: string, ...parts: ReadonlyArray<string | number>) =>
  ["kanban", goalInstanceId, ...parts].join(":");

/** Whether the board started the run, rather than a chat turn. */
export const isBoardRun = (runId: string) => runId.startsWith("kanban:");
