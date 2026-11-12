import { Function as EffectFunction, Schema } from "effect";
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

/** The name a client that registers itself at an OAuth login gives, unless the person chose another. */
export const defaultMcpClientName = "context-generactive-agent";

/**
 * The MCP spec's tool annotations (`ToolAnnotations`), each a hint about what calling a tool does:
 * - `readOnly`: it does not change its environment.
 * - `destructive`: when it changes something, it may delete or overwrite (not only add).
 * - `idempotent`: calling it again with the same arguments changes nothing more.
 * - `openWorld`: it reaches things outside the server, such as the web or other people.
 */
export const McpToolHint = Schema.Literals(["readOnly", "destructive", "idempotent", "openWorld"]);
export type McpToolHint = typeof McpToolHint.Type;

/** A value for each hint, `null` where it is not given. */
const HintValues = Schema.Struct({
  readOnly: Schema.NullOr(Schema.Boolean),
  destructive: Schema.NullOr(Schema.Boolean),
  idempotent: Schema.NullOr(Schema.Boolean),
  openWorld: Schema.NullOr(Schema.Boolean),
});
export type McpHintValues = typeof HintValues.Type;

/** No value for any hint. */
export const noMcpHints: McpHintValues = {
  readOnly: null,
  destructive: null,
  idempotent: null,
  openWorld: null,
};

/** The spec's value for a hint the server leaves out: the cautious assumption. */
export const mcpHintDefaults = {
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true,
} as const satisfies Record<McpToolHint, boolean>;

/** One tool of a connected server: the hints its server gives, and those the user set. */
export const McpToolView = Schema.Struct({
  name: Schema.String,
  server: HintValues,
  user: HintValues,
});
export type McpToolView = typeof McpToolView.Type;

/** Who decides a tool's hint: the user's setting, else the server's annotation, else the spec. */
export const mcpHintSource: {
  (hint: McpToolHint): (tool: McpToolView) => "user" | "server" | "default";
  (tool: McpToolView, hint: McpToolHint): "user" | "server" | "default";
} = EffectFunction.dual(2, (tool: McpToolView, hint: McpToolHint) =>
  tool.user[hint] !== null ? "user" : tool.server[hint] !== null ? "server" : "default",
);

/** The hint a tool's calls are treated by. */
export const mcpHint: {
  (hint: McpToolHint): (tool: McpToolView) => boolean;
  (tool: McpToolView, hint: McpToolHint): boolean;
} = EffectFunction.dual(
  2,
  (tool: McpToolView, hint: McpToolHint): boolean =>
    tool.user[hint] ?? tool.server[hint] ?? mcpHintDefaults[hint],
);

/** What the settings page shows for one server. */
const ServerState = Schema.TaggedUnion({
  untrusted: {},
  /** Trusted once, but the configuration has changed since. */
  changed: {},
  /** Trusted, not started yet (it starts with the next run). */
  trusted: {},
  connected: { tools: Schema.Array(McpToolView) },
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
  /**
   * The name the client registers under at the next login, for a client that registers itself
   * (some authorization servers take only names they know); `null` for other servers, or until
   * the app used the server's login.
   */
  clientName: Schema.NullOr(Schema.String),
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
