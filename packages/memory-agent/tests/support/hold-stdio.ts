// Test/benchmark SDK boundary uses native Promise callbacks, I/O fixtures and synchronous codec assertions.
// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "child") {
  setInterval(() => undefined, 60_000);
} else {
  const pidFile = process.argv[2];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child"], {
    detached: true,
    stdio: ["ignore", process.stdout, process.stderr],
  });
  if (child.pid === undefined) throw new Error("child did not start");
  writeFileSync(pidFile, String(child.pid));
  child.unref();
}
