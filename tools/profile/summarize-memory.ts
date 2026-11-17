import { Array as Arr, Effect, FileSystem, Order, Schema } from "effect";
import { MemoryLine, type MemorySample, type SampledProcess } from "./memory-sample.ts";

const decodeLine = Schema.decodeEffect(MemoryLine);

export const readMemorySamples = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file);
  return yield* Effect.forEach(
    text.split("\n").filter((line) => line.trim() !== ""),
    (line) => decodeLine(line),
  );
});

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);
const percentile = (sorted: ReadonlyArray<number>, fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
const mb = (kb: number) => (kb / 1024).toFixed(0).padStart(8);
const count = (value: number) => String(value).padStart(6);
const rssOf = (processes: ReadonlyArray<SampledProcess>) =>
  sum(processes.map((process) => process.rssKb));

/** min, p50, p95 and max of one number per sample, as a table row in MiB. */
const spreadRow = (label: string, values: ReadonlyArray<number>) => {
  const sorted = Arr.sort(values, Order.Number);
  return `${label.padEnd(24)}${mb(sorted[0] ?? 0)}${mb(percentile(sorted, 0.5))}${mb(percentile(sorted, 0.95))}${mb(sorted.at(-1) ?? 0)}`;
};

interface NameStats {
  readonly name: string;
  /** The most processes of this name alive in one sample. */
  readonly peakCount: number;
  /** The most memory all processes of this name held in one sample. */
  readonly peakTotalKb: number;
  /** The most memory one process of this name held. */
  readonly peakSingleKb: number;
}

/** Per program name, over the processes under the root (the root itself is left out). */
const statsByName = (samples: ReadonlyArray<MemorySample>): ReadonlyArray<NameStats> => {
  const perSample = samples.flatMap(({ rootPid, processes }) =>
    Object.entries(
      Arr.groupBy(
        processes.filter((process) => process.pid !== rootPid),
        (process) => process.name,
      ),
    ).map(([name, group]) => ({
      name,
      count: group.length,
      totalKb: rssOf(group),
      singleKb: Math.max(...group.map((process) => process.rssKb)),
    })),
  );
  return Object.entries(Arr.groupBy(perSample, (entry) => entry.name)).map(([name, entries]) => ({
    name,
    peakCount: Math.max(...entries.map((entry) => entry.count)),
    peakTotalKb: Math.max(...entries.map((entry) => entry.totalKb)),
    peakSingleKb: Math.max(...entries.map((entry) => entry.singleKb)),
  }));
};

interface SampleTotals {
  readonly atUnixMs: number;
  readonly rootKb: number;
  readonly childrenKb: number;
  readonly totalKb: number;
  /** How many processes ran under the root. */
  readonly children: number;
}

const totals = ({ atUnixMs, rootPid, processes }: MemorySample): SampleTotals => {
  const rootKb = rssOf(processes.filter((process) => process.pid === rootPid));
  const totalKb = rssOf(processes);
  return {
    atUnixMs,
    rootKb,
    childrenKb: totalKb - rootKb,
    totalKb,
    children: processes.length - 1,
  };
};

/**
 * Text summary of memory samples: how much the root process and the processes under it held
 * (min, p50, p95, max), the moment the whole tree held the most, and the programs under the root
 * that held the most. Resident memory counts pages shared between processes in each of them, so
 * a sum over processes is an upper bound.
 */
export const summarizeMemory = (samples: ReadonlyArray<MemorySample>, top: number): string =>
  Arr.match(samples.map(totals), {
    onEmpty: () => "(no samples)",
    onNonEmpty: (perSample) => {
      const first = Arr.headNonEmpty(perSample).atUnixMs;
      const peak = Arr.max(
        perSample,
        Order.mapInput(Order.Number, (sample: SampleTotals) => sample.totalKb),
      );
      const names = Arr.sort(
        statsByName(samples),
        Order.flip(Order.mapInput(Order.Number, (stats: NameStats) => stats.peakTotalKb)),
      ).slice(0, top);
      return [
        `samples: ${perSample.length} over ${((Arr.lastNonEmpty(perSample).atUnixMs - first) / 1000).toFixed(0)}s`,
        "",
        `${"resident memory (MiB)".padEnd(24)}${"min".padStart(8)}${"p50".padStart(8)}${"p95".padStart(8)}${"max".padStart(8)}`,
        spreadRow(
          "root process",
          perSample.map((sample) => sample.rootKb),
        ),
        spreadRow(
          "processes under it",
          perSample.map((sample) => sample.childrenKb),
        ),
        spreadRow(
          "whole tree",
          perSample.map((sample) => sample.totalKb),
        ),
        "",
        `peak: ${mb(peak.totalKb).trim()} MiB at +${((peak.atUnixMs - first) / 1000).toFixed(0)}s (root ${mb(peak.rootKb).trim()} MiB, ${peak.children} processes under it ${mb(peak.childrenKb).trim()} MiB)`,
        "",
        `programs under the root, by the most memory held at once (top ${top}):`,
        `${"peak MiB".padStart(8)}${"one MiB".padStart(8)}${"count".padStart(6)}  name`,
        ...names.map(
          (stats) =>
            `${mb(stats.peakTotalKb)}${mb(stats.peakSingleKb)}${count(stats.peakCount)}  ${stats.name}`,
        ),
      ].join("\n");
    },
  });
