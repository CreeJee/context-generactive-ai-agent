import { Schema } from "effect";

/**
 * User-wide settings the browser reads and sends through the app API. This module imports no
 * server code, so the browser bundle can use it; `global-config.ts` stores them.
 */

/**
 * Percent of the context window a conversation fills before its turns are summarized; 0 summarizes
 * from the start. It stays below the share where the oldest messages are left out (55%), so the
 * summaries are ready before anything has to go.
 */
export const SummaryStartPercent = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 }));

/** The most kanban cards the user may let run at once. */
export const kanbanConcurrencyLimit = 32;

/** Kanban cards run at once across every Goal. Machines differ, so the user picks it. */
export const KanbanConcurrency = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: kanbanConcurrencyLimit }),
);

/**
 * How the embedding model runs. `auto` picks `gpu` on a machine with enough memory where WebGPU
 * was found to work, and `cpu` otherwise.
 */
export const EmbeddingChoice = Schema.Literals(["auto", "cpu", "gpu"]);
export type EmbeddingChoice = typeof EmbeddingChoice.Type;

/** Whether the full-precision model ran on WebGPU when this machine was last checked. */
export const GpuCheck = Schema.TaggedUnion({
  available: { checkedAt: Schema.String },
  unavailable: { checkedAt: Schema.String, reason: Schema.String },
});
export type GpuCheck = typeof GpuCheck.Type;

export const CrossProviderMediaConsentMode = Schema.Literals(["disabled", "ask", "always"]);
export type CrossProviderMediaConsentMode = typeof CrossProviderMediaConsentMode.Type;
/** Explicit provider-pair consent. Login or entitlement never creates an entry automatically. */
export const CrossProviderMediaConsentSettings = Schema.Struct({
  version: Schema.Literal(1),
  pairs: Schema.Record(Schema.String, CrossProviderMediaConsentMode),
});
export type CrossProviderMediaConsentSettings = typeof CrossProviderMediaConsentSettings.Type;
