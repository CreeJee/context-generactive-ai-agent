import { Schema } from "effect";
import { ImportSourceName } from "./items.ts";

/** Messages between the server and the import worker (`worker.ts`). */

export const ImportWorkerSetup = Schema.Struct({
  storageRoot: Schema.String,
  /** Where the other agents keep their transcripts (`.claude`, `.codex`). */
  home: Schema.String,
});
export type ImportWorkerSetup = typeof ImportWorkerSetup.Type;

export const ImportWorkerRequest = Schema.Struct({
  id: Schema.Number,
  kind: Schema.Literals(["count", "run"]),
});
export type ImportWorkerRequest = typeof ImportWorkerRequest.Type;

const TranscriptCounts = Schema.Array(
  Schema.Struct({ source: ImportSourceName, transcripts: Schema.Number }),
);

const progressFields = {
  checked: Schema.Number,
  total: Schema.Number,
  written: Schema.Number,
  failed: Schema.Number,
};

export const ImportWorkerReply = Schema.Union([
  Schema.Struct({ id: Schema.Number, kind: Schema.Literal("counts"), counts: TranscriptCounts }),
  Schema.Struct({ id: Schema.Number, kind: Schema.Literal("progress"), ...progressFields }),
  Schema.Struct({
    id: Schema.Number,
    kind: Schema.Literal("finished"),
    ...progressFields,
    counts: TranscriptCounts,
  }),
  Schema.Struct({ id: Schema.Number, kind: Schema.Literal("failed"), reason: Schema.String }),
]);
export type ImportWorkerReply = typeof ImportWorkerReply.Type;
