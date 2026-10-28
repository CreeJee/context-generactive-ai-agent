import { isTruthy } from "../truthy.ts";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, HashSet, Layer, Match, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { findExecutable, helperEnvironment } from "../runtime/host.ts";
import { path as hostPath } from "../runtime/synchronous-path.ts";

/** Git runs with its own folder and the system folders on its search path, and nothing else. */
export const gitEnvironment = (git: string) =>
  helperEnvironment([hostPath.dirname(git)], { user: false });

/**
 * The first `limit` names a Git command prints with `-z`, and whether more followed. Reading stops
 * one name past the limit, so a huge tree costs no more than the names that are kept.
 */
export const gitNames = <E, R>(options: {
  readonly stdout: Stream.Stream<Uint8Array, E, R>;
  readonly limit: number;
}) =>
  options.stdout.pipe(
    Stream.decodeText(),
    // Each chunk completes the name the previous one left open; what follows its last NUL stays open.
    Stream.mapAccum(
      () => "",
      (open, text) => {
        const parts = (open + text).split("\0");
        return [parts.at(-1) ?? "", parts.slice(0, -1)] as const;
      },
      { onHalt: (open) => [open] },
    ),
    Stream.filter((name) => name !== ""),
    Stream.take(options.limit + 1),
    Stream.runCollect,
    Effect.map((names) => ({
      names: names.slice(0, options.limit),
      truncated: names.length > options.limit,
    })),
  );

/** Only ASCII case folding is the same in `git grep -i` and JavaScript. */
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/**
 * Project-relative files below `directory` whose content contains `query`, from `git grep` over
 * tracked and untracked (not ignored) files as they are on disk. Null when Git cannot answer
 * (not a work tree, git missing, or a case-insensitive query with non-ASCII letters), so the caller
 * searches every file instead. Lines are matched afterwards by the caller; this only narrows files.
 * More than `limit` matching files narrow nothing worth keeping, so that is null too.
 */
export const gitGrepFilesEffect = (options: {
  readonly root: string;
  readonly directory: string;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly limit: number;
}) =>
  Effect.gen(function* () {
    const { root, directory, query, caseSensitive, limit } = options;
    if (query.includes("\n") || (!caseSensitive && !isAscii(query))) return null;
    const git = yield* Effect.scoped(
      Layer.build(NodeFileSystem.layer).pipe(
        Effect.flatMap((services) => Effect.provideContext(findExecutable("git"), services)),
      ),
    );
    if (!isTruthy(git)) return null;
    const args = [
      "grep",
      "--untracked",
      "--no-color",
      "-z",
      "-l",
      "-F",
      ...(caseSensitive ? [] : ["-i"]),
      "-e",
      query,
      "--",
      directory,
    ];
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(
          NodeChildProcessSpawner.layer.pipe(
            Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
          ),
        );
        const spawner = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
        const child = yield* spawner.spawn(
          ChildProcess.make(git, args, {
            cwd: root,
            windowsHide: true,
            env: { ...gitEnvironment(git), LANG: "C", GIT_PAGER: "cat" },
            extendEnv: false,
            stderr: "ignore",
          }),
        );
        const matched = yield* gitNames({ stdout: child.stdout, limit });
        // git grep exits 1 when nothing matched; any other failure leaves the search to the caller.
        // One cut short is stopped with its Scope, without waiting for its exit.
        return yield* matched.truncated
          ? Effect.succeed(null)
          : Effect.map(child.exitCode, (code) =>
              Match.value(Number(code)).pipe(
                Match.when(0, () => HashSet.fromIterable(matched.names)),
                Match.when(1, () => HashSet.empty<string>()),
                Match.orElse(() => null),
              ),
            );
      }),
    ).pipe(
      // Without a usable git grep the caller searches the files itself.
      Effect.catchTag("PlatformError", () => Effect.succeed(null)),
    );
  });
