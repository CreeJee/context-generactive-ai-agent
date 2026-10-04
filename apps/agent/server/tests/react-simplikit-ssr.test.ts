import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

// Node exposes storage getters even without a browser. SSR must not probe them.
test.each(["import", "require"])("%s does not read browser storage during SSR", (mode) => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { createRequire } from "node:module";
        let reads = 0;
        for (const key of ["localStorage", "sessionStorage"])
          Object.defineProperty(globalThis, key, {
            configurable: true,
            get() { reads++; throw new Error("Browser storage accessed during SSR"); }
          });
        const hooks = ${mode === "import" ? 'await import("react-simplikit")' : 'createRequire(import.meta.url)("react-simplikit")'};
        if (typeof hooks.useLoading !== "function" || reads !== 0)
          throw new Error("SSR storage reads: " + reads);
      `,
    ],
    { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
});
