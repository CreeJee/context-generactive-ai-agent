// Scoped to the test child. Native addons use real CJS require, never a stub.
import { register } from "node:module";

// Node 26 strips types but cannot erase runtime parameter properties. Transform
// original source modules in memory, without bundling or a built dev backend.
const source = `
import { readFile } from "node:fs/promises";
import { transformWithOxc } from ${JSON.stringify(import.meta.resolve("vite"))};
export async function load(url, context, nextLoad) {
  if (/\\.(?:ts|mts)$/.test(url)) {
    const transformed = await transformWithOxc(await readFile(new URL(url), "utf8"), new URL(url).pathname);
    return { format: "module", shortCircuit: true, source: transformed.code };
  }
  if (!url.endsWith(".node")) return nextLoad(url, context);
  return {
    format: "module",
    shortCircuit: true,
    source: 'import { createRequire } from "node:module"; import { fileURLToPath } from "node:url"; export default createRequire(import.meta.url)(fileURLToPath(' + JSON.stringify(url) + '));',
  };
}
`;
register(`data:text/javascript,${encodeURIComponent(source)}`, import.meta.url);
