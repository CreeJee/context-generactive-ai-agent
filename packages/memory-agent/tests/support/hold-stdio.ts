// Native OS lifecycle probe: publish the detached PID before the command's short timeout.
// Keeping this entry point free of runtime initialization makes it measure inherited pipe cleanup.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "child") {
  setInterval(() => undefined, 60_000);
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child"], {
    detached: true,
    stdio: ["ignore", process.stdout, process.stderr],
  });
  if (child.pid === undefined) throw new Error("child did not start");
  writeFileSync(process.argv[2], String(child.pid));
  child.unref();
}
