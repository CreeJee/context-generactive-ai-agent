import { sha256 as hashSha256 } from "../runtime/synchronous-crypto.ts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { dirname, basename } = platformPath;
import { Context, Effect, FileSystem, Layer, ManagedRuntime } from "effect";
import { NativeRegistrationError } from "./owner-native-error.ts";

// NodeFileSystem's service layer owns no resources. Capture its official service once
// for the existing synchronous factory's production default; operations remain async
// typed Effects and temporary-directory lifetimes stay with their callers.
const runtime = ManagedRuntime.make(NodeFileSystem.layer);
const fs = runtime.runSync(FileSystem.FileSystem);
const registrationError = (cause: import("effect/PlatformError").PlatformError) =>
  NativeRegistrationError.make({ cause });
const filesystem = {
  /** Checks a published artifact's origin and bytes; registration runs this right before it. */
  verify: Effect.fn("OwnerNativeFiles.verify")(function* (
    path: string,
    expectedPath: string,
    sha256: string,
  ) {
    if ((yield* fs.realPath(path).pipe(Effect.mapError(registrationError))) !== expectedPath)
      return yield* NativeRegistrationError.make({ cause: "Unknown native artifact origin" });
    if (hashSha256(yield* fs.readFile(path).pipe(Effect.mapError(registrationError))) !== sha256)
      return yield* NativeRegistrationError.make({
        cause: "Native artifact changed before registration",
      });
  }),
  exists: (path: string) => fs.exists(path).pipe(Effect.mapError(registrationError)),
  publish: Effect.fn("OwnerNativeFiles.publish")(function* (source: string, destination: string) {
    if (yield* fs.exists(destination)) return yield* fs.realPath(destination);
    const temporary = `${destination}.tmp-${process.pid}`;
    yield* fs.makeDirectory(dirname(destination), { recursive: true, mode: 0o700 });
    yield* fs.copyFile(source, temporary);
    yield* fs.rename(temporary, destination).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* fs.remove(temporary, { force: true });
          if (!(yield* fs.exists(destination))) return yield* cause;
        }),
      ),
    );
    return yield* fs.realPath(destination);
  }, Effect.mapError(registrationError)),
  parent: Effect.fn("OwnerNativeFiles.parent")(function* (path: string) {
    yield* fs.makeDirectory(path, { recursive: true, mode: 0o700 });
    return yield* fs.realPath(path);
  }, Effect.mapError(registrationError)),
  realpath: (path: string) => fs.realPath(path).pipe(Effect.mapError(registrationError)),
  read: (path: string) => fs.readFile(path).pipe(Effect.mapError(registrationError)),
  temporary: (prefix: string) =>
    fs
      .makeTempDirectory({ directory: dirname(prefix), prefix: basename(prefix) })
      .pipe(Effect.mapError(registrationError)),
  write: (path: string, code: string) =>
    fs
      .writeFileString(path, code, { flag: "wx", mode: 0o400 })
      .pipe(Effect.mapError(registrationError)),
  remove: (path: string) =>
    fs.remove(path, { recursive: true, force: true }).pipe(Effect.mapError(registrationError)),
};

/** Host filesystem boundaries only; generation ownership stays in the scoped lease. */
export class OwnerNativeFiles extends Context.Service<OwnerNativeFiles, typeof filesystem>()(
  "memory-agent/agent/owner-native-files/OwnerNativeFiles",
) {
  static readonly production = filesystem;
  static readonly layer = Layer.succeed(OwnerNativeFiles, filesystem);
}
