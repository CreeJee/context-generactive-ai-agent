import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Absolute path of the locally built addon. Load it inside a worker thread, not on the request path. */
export const addonPath = fileURLToPath(new URL("./memory-turbovec.node", import.meta.url));

/** Loads the addon. Throws when `vp run build:native` has not produced the binary on this machine. */
export function loadTurbovec() {
  return createRequire(import.meta.url)(addonPath);
}
