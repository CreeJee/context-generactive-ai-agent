import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const child = spawn(process.execPath, ["scripts/dev.ts", ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: {
    ...process.env,
    CONTEXT_AGENT_HOME: `${root}.rrsi-local/runtime`,
    CONTEXT_AGENT_DEV_WEB_PORT: "5174",
    CONTEXT_AGENT_DEV_BACKEND_PORT: "5181",
    CONTEXT_AGENT_RRSI_ORIGINAL_STORAGE: `${process.env.HOME}/.context-generactive-agent`,
    CONTEXT_AGENT_RRSI_REPOSITORY: root,
  },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.once(signal, () => child.kill(signal));
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
