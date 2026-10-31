import { Schema } from "effect";

/**
 * Conversations and who holds them, as the page reads them. This module imports no server code,
 * so the browser bundle can use it; `sessions.ts` and `lease-state.ts` keep them.
 */

export const Session = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** The external ACP agent this conversation talks to directly; null for the app's own model. */
  agent: Schema.NullOr(Schema.String),
  /** When the user archived it: out of the session list, still part of memory. */
  archivedAt: Schema.NullOr(Schema.String),
  /** The coding agent whose transcript this conversation was migrated from; null for one held here. */
  importedFrom: Schema.NullOr(Schema.String),
  /** The git worktree of the project's repository it ran in; null for the checkout itself. */
  worktreePath: Schema.NullOr(Schema.String),
  /** The branch it ran on, when that was recorded. */
  branch: Schema.NullOr(Schema.String),
});
export type Session = typeof Session.Type;

/** Who may change a session, as seen by one page (holder). */
export const LeaseView = Schema.Union([
  /** This page owns the session. */
  Schema.Struct({ state: Schema.Literal("mine") }),
  /** Another page is using it; this one is read-only. */
  Schema.Struct({ state: Schema.Literal("other"), since: Schema.Finite }),
  /** Nobody is using it: a read-only page may continue, after checking again. */
  Schema.Struct({ state: Schema.Literal("free") }),
]);
export type LeaseView = typeof LeaseView.Type;
