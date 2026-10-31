import { Schema } from "effect";

/**
 * Projects as the page reads and changes them. This module imports no server code, so the browser
 * bundle can use it; `projects.ts` stores them.
 */

/**
 * How approval-gated tools (shell, writes outside the project) are allowed.
 * `ask`: the user answers every call. `auto`: a classifier allows, asks or blocks each call first.
 * `full`: approval-gated calls run immediately under the app's path and credential restrictions.
 */
export const PermissionMode = Schema.Literals(["ask", "auto", "full"]);
export type PermissionMode = typeof PermissionMode.Type;

export const Project = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  name: Schema.String,
  crossRecallExcluded: Schema.Boolean,
  permissionMode: PermissionMode,
  createdAt: Schema.String,
  /** When it was taken out of the sidebar; its memory is still there and still searched. */
  hiddenAt: Schema.NullOr(Schema.String),
});
export type Project = typeof Project.Type;

/** What the host's folder dialog answered. */
export const FolderPick = Schema.TaggedUnion({
  picked: { root: Schema.String },
  cancelled: {},
  /** No dialog on this host (no GUI tool, or it failed to start): the path is typed instead. */
  unavailable: {},
});
export type FolderPick = typeof FolderPick.Type;
