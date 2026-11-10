import type { ModelRegistry, ProgressInfo } from "@huggingface/transformers";
import { Effect, HashMap, Stream } from "effect";
import { nativePromise } from "../../runtime/native-effect.ts";
import type { DownloadProgress } from "./contracts.ts";

type FileProgress = Extract<ProgressInfo, { status: "progress" }>;
/** Each file's bytes by its name, as transformers.js counts a load's files. */
type FileBytes = Extract<ProgressInfo, { status: "progress_total" }>["files"];

/**
 * What a model's load reports: before it starts, the files it will download (`planned`, none when
 * every file is cached) or that it could not tell (`unplanned`, as when the network is down);
 * then transformers.js's own reports.
 */
export type LoadReport =
  | ProgressInfo
  | { readonly status: "planned"; readonly files: FileBytes }
  | { readonly status: "unplanned" };

/** The files the load asks for, as `ModelRegistry.get_files` takes them. */
export type PlannedFiles = NonNullable<Parameters<typeof ModelRegistry.get_files>[1]>;

/**
 * The files a load of the model will download, with their sizes, from the cache and the files'
 * metadata, so the download's whole size is known before its first byte. Without it the total grew
 * file by file: the tokenizer's 32MB first, then the model's 540MB.
 */
export const plannedDownload = ({
  registry,
  modelId,
  files,
}: {
  readonly registry: Pick<typeof ModelRegistry, "get_files" | "get_file_metadata">;
  readonly modelId: string;
  readonly files: PlannedFiles;
}): Effect.Effect<LoadReport> =>
  nativePromise(() =>
    registry.get_files(modelId, { ...files, include_tokenizer: true, include_processor: false }),
  ).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        names,
        (file) =>
          nativePromise(() => registry.get_file_metadata(modelId, file)).pipe(
            Effect.map(({ exists, fromCache, size }) =>
              exists && fromCache !== true && size !== undefined && size > 0
                ? [[file, { loaded: 0, total: size }] as const]
                : [],
            ),
          ),
        { concurrency: "unbounded" },
      ),
    ),
    Effect.map((found): LoadReport => ({
      status: "planned",
      files: Object.fromEntries(found.flat()),
    })),
    // The load itself finds out whether the files can be read; this only sizes the download.
    Effect.orElseSucceed((): LoadReport => ({ status: "unplanned" })),
  );

/** The files being downloaded, and whether a download has begun at all. */
interface Downloading {
  readonly files: HashMap.HashMap<string, DownloadProgress>;
  readonly begun: boolean;
}

/** A report of one file's bytes. */
const isFileProgress = (report: LoadReport): report is FileProgress =>
  report.status === "progress" && report.total > 0;

/**
 * A planned file counts from the start. Another file read from the cache reports only its end,
 * complete; one seen part-way is being downloaded, and stays counted until it ends.
 */
const step = (state: Downloading, report: LoadReport): Downloading =>
  report.status === "planned"
    ? {
        files: HashMap.fromIterable(Object.entries(report.files)),
        begun: Object.keys(report.files).length > 0,
      }
    : report.status === "unplanned"
      ? { ...state, begun: true }
      : isFileProgress(report) &&
          (report.loaded < report.total || HashMap.has(state.files, report.file))
        ? {
            files: HashMap.set(state.files, report.file, {
              loaded: report.loaded,
              total: report.total,
            }),
            begun: true,
          }
        : state;

const summed = (files: HashMap.HashMap<string, DownloadProgress>): DownloadProgress =>
  HashMap.reduce(files, { loaded: 0, total: 0 }, (sum, each) => ({
    loaded: sum.loaded + each.loaded,
    total: sum.total + each.total,
  }));

const percent = ({ loaded, total }: DownloadProgress) =>
  total === 0 ? 0 : Math.floor((loaded / total) * 100);

/**
 * The files being downloaded, summed, once the download begins and then each time the whole
 * percent changes, from what a load reports. A total of 0 means the sizes are not known yet. Runs
 * inside the model's worker.
 */
export const downloadProgress = <E, R>(reports: Stream.Stream<LoadReport, E, R>) =>
  reports.pipe(
    Stream.scan((): Downloading => ({ files: HashMap.empty(), begun: false }), step),
    Stream.filter(({ begun }) => begun),
    Stream.map(({ files }) => summed(files)),
    Stream.changesWith(
      (left, right) => left.total === right.total && percent(left) === percent(right),
    ),
  );
