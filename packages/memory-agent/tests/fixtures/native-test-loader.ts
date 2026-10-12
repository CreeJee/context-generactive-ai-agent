// Scoped to the test child. Native addons use real CJS require, never a stub.
import { readFileSync } from "node:fs";
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node 26 strips types but cannot erase runtime parameter properties; only those modules are
// transformed. The hooks run in each thread (workers inherit this `--import`), so worker startup
// does not queue every import behind one shared loader thread.
const { transformSync } = await import(
  pathToFileURL(createRequire(import.meta.resolve("vite")).resolve("rolldown/utils")).href
);

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.(?:ts|mts)$/.test(url)) {
      const source = readFileSync(new URL(url), "utf8");
      let code: string;
      try {
        code = stripTypeScriptTypes(source);
      } catch {
        code = transformSync(fileURLToPath(url), source).code;
      }
      return { format: "module", shortCircuit: true, source: code };
    }
    if (!url.endsWith(".node")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `import { createRequire } from "node:module"; export default createRequire(import.meta.url)(${JSON.stringify(fileURLToPath(url))});`,
    };
  },
});
