import {
  Array as Arr,
  Clock,
  Duration,
  Effect,
  FileSystem,
  HashSet,
  Iterable,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { Function as EffectFunction } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * One process of a sample. `name` is the program's file name without its folder or arguments:
 * arguments can carry prompts, paths or tokens.
 */
export const SampledProcess = Schema.Struct({
  pid: Schema.Int,
  parentPid: Schema.Int,
  /** Resident memory in KiB, as `ps` reports it. Pages shared between processes count in each. */
  rssKb: Schema.Int,
  name: Schema.String,
});
export type SampledProcess = typeof SampledProcess.Type;

/** The root process and every process under it at one moment. */
export const MemorySample = Schema.Struct({
  atUnixMs: Schema.Finite,
  rootPid: Schema.Int,
  processes: Schema.Array(SampledProcess),
});
export type MemorySample = typeof MemorySample.Type;

export const MemoryLine = Schema.fromJsonString(MemorySample);

const psLine = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/;

/** The processes of `ps -axo pid=,ppid=,rss=,comm=` output; a line of another shape is skipped. */
export const parseProcesses = (text: string): ReadonlyArray<SampledProcess> =>
  text.split("\n").flatMap((line) => {
    const [, pid, parentPid, rssKb, command] = psLine.exec(line) ?? [];
    return pid === undefined ||
      parentPid === undefined ||
      rssKb === undefined ||
      command === undefined
      ? []
      : [
          {
            pid: Number(pid),
            parentPid: Number(parentPid),
            rssKb: Number(rssKb),
            name: command.trim().split("/").at(-1) ?? "",
          },
        ];
  });

/** `rootPid` and every process under it, however deep; empty when the root is gone. */
const processTreeBody = (
  processes: ReadonlyArray<SampledProcess>,
  rootPid: number,
): ReadonlyArray<SampledProcess> => {
  const children = Arr.groupBy(processes, (process) => String(process.parentPid));
  const under = (
    frontier: ReadonlyArray<SampledProcess>,
    seen: HashSet.HashSet<number>,
  ): ReadonlyArray<SampledProcess> => {
    const fresh = frontier.filter((process) => !HashSet.has(seen, process.pid));
    return fresh.length === 0
      ? []
      : [
          ...fresh,
          ...under(
            fresh.flatMap((process) => children[String(process.pid)] ?? []),
            HashSet.union(
              seen,
              HashSet.fromIterable(Iterable.map(fresh, (process) => process.pid)),
            ),
          ),
        ];
  };
  return under(
    processes.filter((process) => process.pid === rootPid),
    HashSet.empty(),
  );
};

export const processTree: {
  (
    rootPid: number,
  ): (processes: ReadonlyArray<SampledProcess>) => ReturnType<typeof processTreeBody>;
} & typeof processTreeBody = EffectFunction.dual(2, processTreeBody);

/** Every process of the machine, read with one `ps`. */
const listProcesses = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
          env: { LC_ALL: "C" },
          extendEnv: true,
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      const [stdout] = yield* Effect.all(
        [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
        { concurrency: 2 },
      );
      return parseProcesses(stdout);
    }),
  );
});

/**
 * Appends a sample of `rootPid` and the processes under it to `file` every `interval`, until the
 * root process is gone. The file is NDJSON, one {@link MemorySample} per line.
 */
export const memoryCollector = Effect.fnUntraced(function* (
  rootPid: number,
  file: string,
  interval: Duration.Duration,
) {
  const fs = yield* FileSystem.FileSystem;
  const encode = Schema.encodeEffect(MemoryLine);
  const sample = Effect.gen(function* () {
    const processes = processTree(yield* listProcesses, rootPid);
    return yield* Arr.match(processes, {
      onEmpty: () => Effect.succeed(Option.none<MemorySample>()),
      onNonEmpty: (found) =>
        Effect.gen(function* () {
          const taken = { atUnixMs: yield* Clock.currentTimeMillis, rootPid, processes: found };
          yield* fs.writeFileString(file, `${yield* encode(taken)}\n`, { flag: "a" });
          return Option.some(taken);
        }),
    });
  });
  yield* Effect.repeat(sample, { while: Option.isSome, schedule: Schedule.spaced(interval) });
});
