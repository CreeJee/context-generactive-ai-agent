import { prefix, type RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// Flat routes take .md files as route modules; a folder's README documents it and is not a route.
const ignoredRouteFiles = ["**/README.md"];

// Flat routes skip folders without a route.tsx, so routes/api/* is mounted under /api explicitly.
export default [
  ...(await flatRoutes({ ignoredRouteFiles })),
  ...prefix("api", await flatRoutes({ rootDirectory: "routes/api", ignoredRouteFiles })),
] satisfies RouteConfig;
