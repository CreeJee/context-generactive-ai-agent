import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/** RPC between the secret sweep and the redaction worker (`redact-worker.ts`). */

/** `json`: texts from a JSON column; secrets are hidden in its strings and the structure kept. */
export const RedactKind = Schema.Literals(["text", "json"]);
export type RedactKind = typeof RedactKind.Type;

/** The redaction worker could not hide secrets in a batch; the sweep resumes there next time. */
export class RedactionFailed extends Schema.TaggedError<
  RedactionFailed,
  { readonly brand: unique symbol }
>()("RedactionFailed", {
  /** `redaction-failed`: the detector failed on the batch. `worker-lost`: the worker is gone. */
  reason: Schema.Literals(["redaction-failed", "worker-lost"]),
}) {}

export const Redact = Rpc.make("Redact", {
  payload: Schema.Struct({ kind: RedactKind, texts: Schema.Array(Schema.String) }),
  /** One per text, in the order they were sent. */
  success: Schema.Array(Schema.Struct({ text: Schema.String, hidden: Schema.Finite })),
  error: RedactionFailed,
});

export const RedactRpcs = RpcGroup.make(Redact);
