// Scoped to the test child. Native addons use real CJS require, never a stub.
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Schema } from "effect";

const isBytes = Schema.is(Schema.Uint8Array);

// Node 26 strips types but cannot erase runtime parameter properties; only those modules are
// transformed. The hooks run in each thread (workers inherit this `--import`), so worker startup
// does not queue every import behind one shared loader thread. `vite` is Vite+'s core package,
// which ships rolldown as its own subpath instead of depending on the `rolldown` package.
const { transformSync } = await import(
  pathToFileURL(
    createRequire(import.meta.resolve("vite")).resolve(
      "@voidzero-dev/vite-plus-core/rolldown/utils",
    ),
  ).href
);

const javaScriptOf = (url: string, source: string): string => {
  try {
    return stripTypeScriptTypes(source);
  } catch {
    return transformSync(fileURLToPath(url), source).code;
  }
};

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.(?:ts|mts)$/.test(url)) {
      // The default loader reads the file and leaves TypeScript untouched for these hooks.
      const loaded = nextLoad(url, context);
      if (!isBytes(loaded.source)) return loaded;
      const source = new TextDecoder().decode(loaded.source);
      return { format: "module", shortCircuit: true, source: javaScriptOf(url, source) };
    }
    if (!url.endsWith(".node")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `import { createRequire } from "node:module"; export default createRequire(import.meta.url)(${JSON.stringify(fileURLToPath(url))});`,
    };
  },
});
