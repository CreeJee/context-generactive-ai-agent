import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, HashSet, Iterable, Layer, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { gitEnvironment, gitNames } from "../files/git-grep.ts";
import { findExecutable } from "../runtime/host.ts";
import { path } from "../runtime/synchronous-path.ts";
import { isTruthy } from "../truthy.ts";

/** More skill folders than any project keeps; past it the listing stops counting as an answer. */
const folderLimit = 10_000;

/**
 * The skill folders under `<root>/.agents/skills` that the commit checked out in `root` has. A
 * kanban card's worktree starts from a commit, so a folder only the user's copy has (saved there
 * and never committed) is not one a card can run. None when git cannot answer (git missing, not a
 * repository, no commit yet): then every folder there counts, as nothing else can see the folder.
 */
export const committedSkillFolders = Effect.fn("Skills.committedFolders")(function* (root: string) {
  const git = yield* Effect.scoped(
    Layer.build(NodeFileSystem.layer).pipe(
      Effect.flatMap((services) => Effect.provideContext(findExecutable("git"), services)),
    ),
  );
  if (!isTruthy(git)) return Option.none<HashSet.HashSet<string>>();
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        NodeChildProcessSpawner.layer.pipe(
          Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
        ),
      );
      const spawner = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
      const child = yield* spawner.spawn(
        ChildProcess.make(git, ["ls-tree", "-z", "--name-only", "HEAD", "--", ".agents/skills/"], {
          cwd: root,
          windowsHide: true,
          env: gitEnvironment(git),
          extendEnv: false,
          stderr: "ignore",
        }),
      );
      const listed = yield* gitNames({ stdout: child.stdout, limit: folderLimit });
      const code = yield* child.exitCode;
      return Number(code) === 0 && !listed.truncated
        ? Option.some(
            HashSet.fromIterable(Iterable.map(listed.names, (name) => path.basename(name))),
          )
        : Option.none<HashSet.HashSet<string>>();
    }),
  ).pipe(Effect.catchTag("PlatformError", () => Effect.succeedNone));
});
