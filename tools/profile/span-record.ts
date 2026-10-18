import { Context, Effect, FileSystem, Layer, Schema, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";

const ScalarAttribute = Schema.Union([Schema.Finite, Schema.Boolean]);
const isScalarAttribute = Schema.is(ScalarAttribute);

/** One finished span: the line both collectors append and `summarize` reads. */
export const SpanRecord = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.NullOr(Schema.String),
  name: Schema.String,
  startUnixMs: Schema.Finite,
  durationMs: Schema.Finite,
  outcome: Schema.Literals(["ok", "error", "interrupted"]),
  /** Numbers and booleans only: string values can carry prompts, paths or provider errors. */
  attributes: Schema.Record(Schema.String, ScalarAttribute),
});
export type SpanRecord = typeof SpanRecord.Type;

export const SpanLine = Schema.fromJsonString(SpanRecord);

export const scalarAttributes = (entries: Iterable<readonly [string, unknown]>) => {
  const kept: Record<string, number | boolean> = {};
  for (const [key, value] of entries) if (isScalarAttribute(value)) kept[key] = value;
  return kept;
};

export const nanosToMillis = (nanos: bigint) => Number(nanos / 1_000n) / 1_000;

/** Appends records to one NDJSON file; one write at a time so concurrent batches never interleave. */
export class SpanWriter extends Context.Service<
  SpanWriter,
  {
    readonly file: string;
    readonly write: (
      records: ReadonlyArray<SpanRecord>,
    ) => Effect.Effect<void, PlatformError | Schema.SchemaError>;
  }
>()("tools/profile/span-record/SpanWriter") {
  static readonly layer = (file: string) =>
    Layer.effect(
      SpanWriter,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const oneWrite = yield* Semaphore.make(1);
        const encode = Schema.encodeEffect(SpanLine);
        const write = Effect.fnUntraced(function* (records: ReadonlyArray<SpanRecord>) {
          if (records.length === 0) return;
          const lines = yield* Effect.forEach(records, (record) => encode(record));
          yield* oneWrite.withPermit(
            fs.writeFileString(file, `${lines.join("\n")}\n`, { flag: "a" }),
          );
        });
        return SpanWriter.of({ file, write });
      }),
    );
}
