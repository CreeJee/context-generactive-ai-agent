import { Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, HashSet, Layer, Path, Stream, Cause } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { findExecutable, helperEnvironment } from "../runtime/host.ts";

/** Git runs with its own folder and the system folders on its search path, and nothing else. */
const hostPath = Effect.runSync(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(NodePath.layer);
      return Context.get(services, Path.Path);
    }),
  ),
);
export const gitEnvironment = (git: string) =>
  helperEnvironment([hostPath.dirname(git)], { user: false });

/** Only ASCII case folding is the same in `git grep -i` and JavaScript. */
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/**
 * Project-relative files below `directory` whose content contains `query`, from `git grep` over
 * tracked and untracked (not ignored) files as they are on disk. Null when Git cannot answer
 * (not a work tree, git missing, or a case-insensitive query with non-ASCII letters), so the caller
 * searches every file instead. Lines are matched afterwards by the caller; this only narrows files.
 */
export const gitGrepFiles: {
  (
    directory: string,
    query: string,
    caseSensitive: boolean,
  ): (root: string) => ReturnType<typeof gitGrepFilesBody>;
} & typeof gitGrepFilesBody = EffectFunction.dual(4, gitGrepFilesBody);
function gitGrepFilesBody(
  root: string,
  directory: string,
  query: string,
  caseSensitive: boolean,
): Promise<HashSet.HashSet<string> | null> {
  return Effect.runPromise(gitGrepFilesEffect({ root, directory, query, caseSensitive }));
}

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
        let size = 0;
        const stdout = yield* child.stdout.pipe(
          Stream.mapEffect((chunk) => {
            size += chunk.byteLength;
            return size <= 64 * 1024 * 1024
              ? Effect.succeed(chunk)
              : Effect.fail(new Cause.UnknownError("git grep output exceeds 64 MiB"));
          }),
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        );
        const code = yield* child.exitCode;
        switch (Number(code)) {
          case 0:
            return HashSet.fromIterable(stdout.split("\0").filter(Boolean));
          case 1:
            return HashSet.empty<string>();
          default:
            return null;
        }
      }),
    ).pipe(Effect.orElseSucceed(() => null));
  });
