import { Schema } from "effect";
import {
  ConfigFileFailureCode,
  ExternalAgentFailureCode,
  shownFailure,
} from "../runtime/shown-failure.ts";

/**
 * External agents as the settings page shows them. This module imports no server code, so the
 * browser bundle can use it; `agents.ts` builds the overview.
 */

export const AgentScope = Schema.Literals(["global", "project"]);
export type AgentScope = typeof AgentScope.Type;

/** Connection state of one external agent, as settings show it. */
const LinkState = Schema.TaggedUnion({
  idle: {},
  connecting: { failures: Schema.Finite },
  connected: { agent: Schema.NullOr(Schema.String), loadSession: Schema.Boolean },
  /** The last attempt failed; the next use (or the automatic reconnect) tries again. */
  retrying: { failures: Schema.Finite, failure: shownFailure(ExternalAgentFailureCode) },
  /** Gave up after consecutive failures; only a manual reconnect tries again. */
  stopped: { failures: Schema.Finite, failure: shownFailure(ExternalAgentFailureCode) },
});
export type AgentLinkState = typeof LinkState.Type;

const TrustState = Schema.TaggedUnion({
  untrusted: {},
  changed: {},
  trusted: { link: LinkState },
});
export type AgentTrustState = typeof TrustState.Type;

export const ExternalAgentView = Schema.Struct({
  scope: AgentScope,
  name: Schema.String,
  /** `command args…` as configured, with secrets hidden; `null` when they could not be checked. */
  target: Schema.NullOr(Schema.String),
  envNames: Schema.Array(Schema.String),
  shadowed: Schema.Boolean,
  state: TrustState,
});
export type ExternalAgentView = typeof ExternalAgentView.Type;

export const ExternalAgentsOverview = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      scope: AgentScope,
      path: Schema.String,
      error: Schema.NullOr(shownFailure(ConfigFileFailureCode)),
    }),
  ),
  agents: Schema.Array(ExternalAgentView),
});
export type ExternalAgentsOverview = typeof ExternalAgentsOverview.Type;
