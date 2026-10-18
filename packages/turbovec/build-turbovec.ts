import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Why the local addon was not built. */
class TurbovecBuildFailed extends Schema.TaggedError<TurbovecBuildFailed>()("TurbovecBuildFailed", {
  reason: Schema.Literals(["cargo-failed", "unsupported-host"]),
  exitCode: Schema.optional(Schema.Int),
}) {}

const BuildHost = Schema.Literals(["darwin", "linux", "win32"]);
const libraries = {
  darwin: "libmemory_turbovec.dylib",
  linux: "libmemory_turbovec.so",
  win32: "memory_turbovec.dll",
} satisfies Record<typeof BuildHost.Type, string>;

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("./", import.meta.url));
  const host = yield* Schema.decodeUnknownEffect(BuildHost)(process.platform).pipe(
    Effect.mapError(() => TurbovecBuildFailed.make({ reason: "unsupported-host" })),
  );
  const cargo = yield* Config.String("CARGO").pipe(Config.withDefault("cargo"));
  yield* spawner
    .exitCode(
      ChildProcess.make(
        cargo,
        ["build", "--release", "--locked", "--manifest-path", path.join(root, "Cargo.toml")],
        { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      ),
    )
    .pipe(
      Effect.filterOrFail(
        (exitCode) => exitCode === 0,
        (exitCode) => TurbovecBuildFailed.make({ reason: "cargo-failed", exitCode }),
      ),
    );
  // Do not truncate a library already mmap'ed by a running user server.
  const destination = path.join(root, "memory-turbovec.node");
  const staged = `${destination}.${process.pid}.tmp`;
  yield* fs.copyFile(path.join(root, "target/release", libraries[host]), staged);
  yield* fs.rename(staged, destination);
  yield* Console.log(
    "Built local turbovec addon; no cross-platform binary distribution is implied.",
  );
});

// Script entry point: the whole program gets its layer here.
// @effect-diagnostics-next-line strictEffectProvide:off
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
