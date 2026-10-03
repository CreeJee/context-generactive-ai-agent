import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { NativeRegistrationError } from "./owner-native-error.ts";

const attempt = <A>(work: () => A) =>
  Effect.try({
    try: work,
    catch: (cause) => new NativeRegistrationError({ cause }),
  });
const filesystem = {
  // The Node SQLite atomic callback cannot suspend. Keep this native inspection
  // synchronous so registration rechecks origin and bytes inside that fence;
  // its exceptions are mapped by the surrounding typed database boundary.
  verifyAtFence: (path: string, parent: string, sha256: string) => {
    if (!realpathSync(path).startsWith(parent + "/generation-"))
      throw new Error("Unknown native artifact origin");
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== sha256)
      throw new Error("Native artifact changed before registration");
  },
  parent: (path: string) =>
    attempt(() => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      return realpathSync(path);
    }),
  realpath: (path: string) => attempt(() => realpathSync(path)),
  read: (path: string) => attempt(() => readFileSync(path)),
  temporary: (prefix: string) => attempt(() => mkdtempSync(prefix)),
  write: (path: string, code: string) =>
    attempt(() => writeFileSync(path, code, { flag: "wx", mode: 0o400 })),
  remove: (path: string) => attempt(() => rmSync(path, { recursive: true, force: true })),
};

/** Host filesystem boundaries only; generation ownership stays in the scoped lease. */
export class OwnerNativeFiles extends Context.Service<OwnerNativeFiles, typeof filesystem>()(
  "memory-agent/agent/OwnerNativeFiles",
) {
  static readonly production = filesystem;
  static readonly layer = Layer.succeed(OwnerNativeFiles, filesystem);
}
