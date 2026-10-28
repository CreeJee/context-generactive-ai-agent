import { isTruthy } from "../truthy.ts";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, HashSet, Layer, Match, Stream, Cause } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { findExecutable, helperEnvironment } from "../runtime/host.ts";
import { path as hostPath } from "../runtime/synchronous-path.ts";

/** Git runs with its own folder and the system folders on its search path, and nothing else. */
export const gitEnvironment = (git: string) =>
  helperEnvironment([hostPath.dirname(git)], { user: false });

/** A Git command's output as text, failing with `overflow` once it passes `maxBytes`. */
export const gitOutputText = <E, R>(options: {
  readonly stdout: Stream.Stream<Uint8Array, E, R>;
  readonly maxBytes: number;
  readonly overflow: string;
}) =>
  options.stdout.pipe(
    // Each chunk carries the output size up to and including it.
    Stream.mapAccum(
      () => 0,
      (size, chunk) => [size + chunk.byteLength, [[size + chunk.byteLength, chunk] as const]],
    ),
    Stream.mapEffect(([size, chunk]) =>
      size <= options.maxBytes
        ? Effect.succeed(chunk)
        : Effect.fail(new Cause.UnknownError(options.overflow)),
    ),
    Stream.decodeText(),
    Stream.mkString,
  );

/** Only ASCII case folding is the same in `git grep -i` and JavaScript. */
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/**
 * Project-relative files below `directory` whose content contains `query`, from `git grep` over
 * tracked and untracked (not ignored) files as they are on disk. Null when Git cannot answer
 * (not a work tree, git missing, or a case-insensitive query with non-ASCII letters), so the caller
 * searches every file instead. Lines are matched afterwards by the caller; this only narrows files.
 */
export const gitGrepFilesEffect = (options: {
  readonly root: string;
  readonly directory: string;
  readonly query: string;
  readonly caseSensitive: boolean;
}) =>
  Effect.gen(function* () {
    const { root, directory, query, caseSensitive } = options;
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
        const stdout = yield* gitOutputText({
          stdout: child.stdout,
          maxBytes: 64 * 1024 * 1024,
          overflow: "git grep output exceeds 64 MiB",
        });
        // git grep exits 1 when nothing matched; any other failure leaves the search to the caller.
        return Match.value(Number(yield* child.exitCode)).pipe(
          Match.when(0, () => HashSet.fromIterable(stdout.split("\0").filter(Boolean))),
          Match.when(1, () => HashSet.empty<string>()),
          Match.orElse(() => null),
        );
      }),
    ).pipe(
      // Without a usable git grep the caller searches the files itself.
      Effect.catchTags({
        PlatformError: () => Effect.succeed(null),
        UnknownError: () => Effect.succeed(null),
      }),
    );
  });
