// `#server-build` (package.json "imports") is React Router's server build, `build/server/index.js`.
declare module "#server-build" {
  import type { ServerBuild } from "react-router";
  import type * as ServerEntry from "../app/entry.server.tsx";
  const build: ServerBuild & { readonly entry: { readonly module: typeof ServerEntry } };
  export = build;
}
