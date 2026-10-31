import { HttpApiMiddleware } from "effect/http-api";

/**
 * Every answer of the group, refusals included, carries `Cache-Control: no-store`: what it answers
 * (accounts, quota) is read fresh each time and kept by no cache. This module imports no server
 * code, so the browser bundle can use it.
 */
export class NoStore extends HttpApiMiddleware.Service<NoStore>()(
  "memory-agent/api/no-store/NoStore",
) {}
