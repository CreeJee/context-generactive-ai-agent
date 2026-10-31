import { Schema } from "effect";
import {
  ConfigFileFailureCode,
  McpFailureCode,
  McpLoginFailureCode,
  shownFailure,
} from "../runtime/shown-failure.ts";

/**
 * MCP servers as the settings page shows them. This module imports no server code, so the browser
 * bundle can use it; `servers.ts` builds the overview.
 */

/** Where MCP servers are configured: user-wide in the storage root, or in a project. */
export const McpScope = Schema.Literals(["global", "project"]);
export type McpScope = typeof McpScope.Type;

/** What the settings page shows for one server. */
const ServerState = Schema.TaggedUnion({
  untrusted: {},
  /** Trusted once, but the configuration has changed since. */
  changed: {},
  /** Trusted, not started yet (it starts with the next run). */
  trusted: {},
  connected: { tools: Schema.Array(Schema.String) },
  failed: { failure: shownFailure(McpFailureCode) },
  /**
   * The server asked for authorization that no stored login answers. `failure` is why the last
   * login did not finish, if it did not.
   */
  needsLogin: { failure: Schema.NullOr(shownFailure(McpLoginFailureCode)) },
  /** A login waits for the person at `authorizationUrl`, in their browser. */
  loggingIn: { authorizationUrl: Schema.String },
});
export type McpServerState = typeof ServerState.Type;

/** One server. Environment and header values are never included. */
export const McpServerView = Schema.Struct({
  scope: McpScope,
  name: Schema.String,
  /** The `McpServerConfig` case. */
  transport: Schema.Literals(["stdio", "http"]),
  /**
   * `command args…` or the URL, as configured (variables not expanded), with secrets hidden;
   * `null` when they could not be checked.
   */
  target: Schema.NullOr(Schema.String),
  envNames: Schema.Array(Schema.String),
  headerNames: Schema.Array(Schema.String),
  /** A project server with the same name replaces this global one. */
  shadowed: Schema.Boolean,
  /** A person's OAuth login to the server is stored (known once the app used or made it). */
  signedIn: Schema.Boolean,
  state: ServerState,
});
export type McpServerView = typeof McpServerView.Type;

export const McpOverview = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      scope: McpScope,
      path: Schema.String,
      error: Schema.NullOr(shownFailure(ConfigFileFailureCode)),
    }),
  ),
  servers: Schema.Array(McpServerView),
});
export type McpOverview = typeof McpOverview.Type;
