import * as NodePath from "@effect/platform-node/NodePath";
import { ManagedRuntime, Path } from "effect";

// Path layers have no resources and their operations are pure and synchronous.
// Capture the official services for SQLite callbacks and synchronous SDK APIs.
const nativeRuntime = ManagedRuntime.make(NodePath.layer);
const posixRuntime = ManagedRuntime.make(NodePath.layerPosix);
const windowsRuntime = ManagedRuntime.make(NodePath.layerWin32);
export const path = nativeRuntime.runSync(Path.Path);
export const posix = posixRuntime.runSync(Path.Path);
export const win32 = windowsRuntime.runSync(Path.Path);
