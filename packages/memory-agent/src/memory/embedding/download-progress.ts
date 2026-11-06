import type { ProgressInfo } from "@huggingface/transformers";
import { HashMap, Stream } from "effect";
import type { DownloadProgress } from "./contracts.ts";

type FileProgress = Extract<ProgressInfo, { status: "progress" }>;

/** A report of one file's bytes; the callback's other reports are skipped. */
const isFileProgress = (report: ProgressInfo): report is FileProgress =>
  report.status === "progress" && report.total > 0;

/**
 * A file read from the cache reports only its end, complete; a file seen part-way is being
 * downloaded, and stays counted until it ends.
 */
const downloading = (
  files: HashMap.HashMap<string, DownloadProgress>,
  { file, loaded, total }: FileProgress,
) =>
  loaded < total || HashMap.has(files, file) ? HashMap.set(files, file, { loaded, total }) : files;

const summed = (files: HashMap.HashMap<string, DownloadProgress>): DownloadProgress =>
  HashMap.reduce(files, { loaded: 0, total: 0 }, (sum, each) => ({
    loaded: sum.loaded + each.loaded,
    total: sum.total + each.total,
  }));

const percent = ({ loaded, total }: DownloadProgress) => Math.floor((loaded / total) * 100);

/**
 * The files being downloaded, summed, each time the whole percent changes, from the reports a
 * transformers.js progress callback receives. Runs inside the model's worker.
 */
export const downloadProgress = <E, R>(reports: Stream.Stream<ProgressInfo, E, R>) =>
  reports.pipe(
    Stream.filter(isFileProgress),
    Stream.scan(HashMap.empty<string, DownloadProgress>, downloading),
    Stream.map(summed),
    Stream.filter(({ total }) => total > 0),
    Stream.changesWith((left, right) => percent(left) === percent(right)),
  );
