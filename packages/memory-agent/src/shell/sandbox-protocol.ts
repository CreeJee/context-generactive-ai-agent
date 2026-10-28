import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

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

export class SandboxUnavailable extends Schema.TaggedError<
  SandboxUnavailable,
  { readonly brand: unique symbol }
>()("SandboxUnavailable", { reason: SandboxUnavailableReason, detail: Schema.String }) {
  override get message() {
    return `sandbox_unavailable (${this.reason}): ${this.detail}`;
  }
}

/** The sandbox's violation log could not be read; the command's own stderr stands. */
export class SandboxReportFailed extends Schema.TaggedError<
  SandboxReportFailed,
  { readonly brand: unique symbol }
>()("SandboxReportFailed", { reason: Schema.Literals(["annotate_failed"]) }) {}

/** The command line to run instead of the original one, or why the sandbox cannot run it. */
export const Prepare = Rpc.make("Prepare", { success: Schema.String, error: SandboxUnavailable });
/** Sent once the command has exited: its stderr with what the sandbox blocked appended. */
export const Finish = Rpc.make("Finish", {
  payload: { stderr: Schema.String },
  success: Schema.String,
  error: SandboxReportFailed,
});
export const SandboxRpcs = RpcGroup.make(Prepare, Finish);
