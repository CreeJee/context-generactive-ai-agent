import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("./", import.meta.url));
const build = spawnSync(
  process.env.CARGO ?? "cargo",
  ["build", "--release", "--locked", "--manifest-path", join(root, "Cargo.toml")],
  { stdio: "inherit" },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const libraries: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "libmemory_turbovec.dylib",
  linux: "libmemory_turbovec.so",
  win32: "memory_turbovec.dll",
};
const library = libraries[process.platform];
if (!library) throw new Error("Unsupported build host");
copyFileSync(join(root, "target/release", library), join(root, "memory-turbovec.node"));
console.log("Built local turbovec addon; no cross-platform binary distribution is implied.");
