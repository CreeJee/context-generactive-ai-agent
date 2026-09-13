import { prefix, type RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// Flat routes skip folders without a route.tsx, so routes/api/* is mounted under /api explicitly.
export default [
  ...(await flatRoutes()),
  ...prefix("api", await flatRoutes({ rootDirectory: "routes/api" })),
] satisfies RouteConfig;
