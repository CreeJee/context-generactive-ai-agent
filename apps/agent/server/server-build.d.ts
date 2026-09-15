// `#server-build` (package.json "imports") is React Router's server build, `build/server/index.js`.
declare module "#server-build" {
  import type { ServerBuild } from "react-router";
  const build: ServerBuild;
  export = build;
}
