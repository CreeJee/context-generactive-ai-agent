import { Schema } from "effect";

/** What one sandboxed command may do, sent to its worker as `workerData.sandbox`. */
export const SandboxSetup = Schema.Struct({
  command: Schema.String,
  /** Keys the violations recorded while the command runs. */
  commandId: Schema.String,
  network: Schema.Array(Schema.String),
  /** Binding and connecting to loopback ports directly, outside the host filter. */
  allowLocalBinding: Schema.Boolean,
  allowWrite: Schema.Array(Schema.String),
  denyRead: Schema.Array(Schema.String),
  denyWrite: Schema.Array(Schema.String),
});
export type SandboxSetup = typeof SandboxSetup.Type;

export const SandboxUnavailableReason = Schema.Literals([
  "unsupported_platform",
  "missing_dependencies",
  "setup_failed",
]);

export const SandboxReply = Schema.Union([
  /** The command line to run instead of the original one. */
  Schema.TaggedStruct("Wrapped", { command: Schema.String }),
  Schema.TaggedStruct("Unavailable", { reason: SandboxUnavailableReason, detail: Schema.String }),
  /** The command's stderr with what the sandbox blocked appended; null if that could not be read. */
  Schema.TaggedStruct("Finished", { stderr: Schema.NullOr(Schema.String) }),
]);
export type SandboxReply = typeof SandboxReply.Type;

/** Sent once the command has exited, so the worker can report what it blocked and stop. */
export const SandboxFinish = Schema.TaggedStruct("Finish", { stderr: Schema.String });
export type SandboxFinish = typeof SandboxFinish.Type;
