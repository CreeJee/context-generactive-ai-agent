import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ImportSourceName } from "./items.ts";

/** Effect RPC between the server and the import worker (`worker.ts`). */

/** What the import worker is started with; the server owns every field. */
export const ImportWorkerSetup = Schema.Struct({
  storageRoot: Schema.String,
  /** Where the other agents keep their transcripts (`.claude`, `.codex`). */
  home: Schema.String,
});
export type ImportWorkerSetup = typeof ImportWorkerSetup.Type;

/** The import worker could not run a pass or a count at all. */
export class ImportWorkerFailed extends Schema.TaggedError<ImportWorkerFailed>()(
  "ImportWorkerFailed",
  {
    /**
     * `start`: the worker could not be started. `count` and `pass`: the worker could not count the
     * transcripts or finish a pass; it stays, and the cause stays in its log. `lost`: the worker or
     * its channel is gone; the next request starts a new one.
     */
    reason: Schema.Literals(["start", "count", "pass", "lost"]),
  },
) {}

const TranscriptCounts = Schema.Array(
  Schema.Struct({ source: ImportSourceName, transcripts: Schema.Finite }),
);

const progressFields = {
  checked: Schema.Finite,
  total: Schema.Finite,
  written: Schema.Finite,
  failed: Schema.Finite,
};

/** What a pass streams: any number of `Progress` events, then one `Finished`. */
export const PassEvent = Schema.Union([
  Schema.TaggedStruct("Progress", progressFields),
  Schema.TaggedStruct("Finished", { ...progressFields, counts: TranscriptCounts }),
]);
export type PassEvent = typeof PassEvent.Type;

/** Transcripts on disk per source. */
export const Count = Rpc.make("Count", { success: TranscriptCounts, error: ImportWorkerFailed });
/** One pass over every transcript. */
export const Run = Rpc.make("Run", { success: PassEvent, error: ImportWorkerFailed, stream: true });

export const ImportRpcs = RpcGroup.make(Count, Run);
