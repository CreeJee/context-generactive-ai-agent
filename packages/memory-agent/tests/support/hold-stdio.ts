// A deliberately detached child retains inherited pipes; the parent test owns its final SIGKILL.
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const argument = yield* Schema.decodeEffect(Schema.NonEmptyString)(process.argv[2] ?? "");
      if (argument === "child") {
        return yield* Effect.sleep("60 seconds").pipe(Effect.forever);
      }
      const platform = yield* Layer.build(NodeServices.layer);
      const fs = Context.get(platform, FileSystem.FileSystem);
      const path = Context.get(platform, Path.Path);
      const spawner = Context.get(platform, ChildProcessSpawner.ChildProcessSpawner);
      const executable = yield* path.fromFileUrl(new URL(import.meta.url));
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [executable, "child"], {
          detached: true,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
      yield* fs.writeFileString(argument, String(child.pid));
      // The official unref operation also prevents the spawner Scope from killing the detached child.
      const rereference = yield* child.unref;
      void rereference;
    }),
  ),
);
