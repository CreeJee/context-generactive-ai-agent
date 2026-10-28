import {
  Array as Arr,
  Effect,
  FileSystem,
  MutableHashMap,
  MutableHashSet,
  Option,
  Schema,
} from "effect";
import { SpanLine, type SpanRecord } from "./span-record.ts";

const decodeLine = Schema.decodeEffect(SpanLine);

export const readSpans = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file);
  return yield* Effect.forEach(
    text.split("\n").filter((line) => line.trim() !== ""),
    (line) => decodeLine(line),
  );
});

interface NameStats {
  readonly name: string;
  readonly durations: ReadonlyArray<number>;
  readonly selfMs: number;
  readonly errors: number;
  readonly interrupted: number;
}

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);
const percentile = (sorted: ReadonlyArray<number>, fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
const ms = (value: number) => value.toFixed(1).padStart(10);

/** Per-name totals plus self time; self time is clamped at 0 where children ran concurrently. */
const statsByName = (spans: ReadonlyArray<SpanRecord>) => {
  const childTime = MutableHashMap.empty<string, number>();
  spans
    .flatMap(({ parentSpanId, durationMs }) =>
      parentSpanId === null ? [] : [[parentSpanId, durationMs] as const],
    )
    .forEach(([parent, durationMs]) =>
      MutableHashMap.modifyAt(childTime, parent, (current) =>
        Option.some(Option.getOrElse(current, () => 0) + durationMs),
      ),
    );
  const selfOf = (span: SpanRecord) =>
    Math.max(
      0,
      span.durationMs - Option.getOrElse(MutableHashMap.get(childTime, span.spanId), () => 0),
    );
  return Object.entries(Arr.groupBy(spans, (span) => span.name)).map(
    ([name, group]): NameStats => ({
      name,
      durations: group.map((span) => span.durationMs),
      selfMs: sum(group.map(selfOf)),
      errors: group.filter((span) => span.outcome === "error").length,
      interrupted: group.filter((span) => span.outcome === "interrupted").length,
    }),
  );
};

const statsTable = (title: string, rows: ReadonlyArray<NameStats>) => [
  title,
  "  total ms     self ms  count     p50 ms     p95 ms     max ms  err  int  name",
  ...rows.map((row) => {
    const sorted = row.durations.toSorted((a, b) => a - b);
    return [
      ms(sum(sorted)),
      ms(row.selfMs),
      String(sorted.length).padStart(6),
      ms(percentile(sorted, 0.5)),
      ms(percentile(sorted, 0.95)),
      ms(sorted.at(-1) ?? 0),
      String(row.errors).padStart(4),
      String(row.interrupted).padStart(4),
      ` ${row.name}`,
    ].join(" ");
  }),
];

/** The slowest spans with the chain of span names above them, outermost first. */
const slowestPaths = (spans: ReadonlyArray<SpanRecord>, top: number) => {
  const byId = MutableHashMap.fromIterable(spans.map((span) => [span.spanId, span] as const));
  const parentOf = (span: SpanRecord) =>
    Option.flatMap(Option.fromNullishOr(span.parentSpanId), (id) => MutableHashMap.get(byId, id));
  const pathOf = (span: SpanRecord) =>
    [
      // The names above the span come nearest first; the path reads outermost first.
      ...Arr.unfold(
        parentOf(span),
        Option.map((parent) => [parent.name, parentOf(parent)] as const),
      ).reverse(),
      span.name,
    ].join(" > ");
  return spans
    .toSorted((a, b) => b.durationMs - a.durationMs)
    .slice(0, top)
    .map((span) => `${ms(span.durationMs)}  ${span.outcome.padEnd(11)} ${pathOf(span)}`);
};

export const summarizeSpans = (spans: ReadonlyArray<SpanRecord>, top: number) => {
  const stats = statsByName(spans);
  const traces = MutableHashSet.size(
    MutableHashSet.fromIterable(spans.map((span) => span.traceId)),
  );
  return [
    `span ${spans.length}개, trace ${traces}개`,
    "",
    ...statsTable(
      `total 기준 상위 ${top}`,
      stats.toSorted((a, b) => sum(b.durations) - sum(a.durations)).slice(0, top),
    ),
    "",
    ...statsTable(
      `self 기준 상위 ${top}`,
      stats.toSorted((a, b) => b.selfMs - a.selfMs).slice(0, top),
    ),
    "",
    `가장 느린 span ${Math.min(top, spans.length)}개 (경로는 바깥쪽부터)`,
    ...slowestPaths(spans, top),
  ].join("\n");
};
