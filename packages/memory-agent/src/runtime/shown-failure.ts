import { Option, Schema } from "effect";
import { runtimeCopy } from "./copy.ts";

/**
 * Failures of outside programs (external agents, MCP servers, their config files, a chat run) as
 * people see them. `code` is chosen by the app and picks the wording; `detail` is the program's
 * own text with secrets hidden, shown only on request and never branched on.
 */
export interface ShownFailure<Code extends string> {
  readonly code: Code;
  readonly detail: string | null;
}

/** The Schema of a `ShownFailure` whose code `code` decodes. */
export const shownFailure = <Code extends Schema.Top>(code: Code) =>
  Schema.Struct({ code, detail: Schema.NullOr(Schema.String) });

/** Why an external agent did not connect or answer. */
export const ExternalAgentFailureCode = Schema.Literals([
  /** A `${NAME}` the command or its environment uses is not set. */
  "missing_env",
  /** The command could not be started. */
  "spawn_failed",
  "initialize_timed_out",
  /** The agent answered a request with an error. */
  "agent_error",
  /** The connection failed some other way. */
  "connection_failed",
  "session_failed",
  "not_trusted",
  "stopped_after_failures",
  /** The connection dropped mid-answer; the prompt was not sent again. */
  "disconnected",
]);
export type ExternalAgentFailureCode = typeof ExternalAgentFailureCode.Type;

/** Why a trusted MCP server offers no tools. */
export const McpFailureCode = Schema.Literals([
  "missing_env",
  "connect_timed_out",
  "tools_list_timed_out",
  /** Starting, connecting or listing failed some other way. */
  "start_failed",
]);
export type McpFailureCode = typeof McpFailureCode.Type;

/** Why a login to an MCP server's authorization server did not finish. */
export const McpLoginFailureCode = Schema.Literals([
  /** The loopback port the browser returns to is taken. */
  "callback_port_unavailable",
  "login_timed_out",
  /** The person or the authorization server refused (`access_denied`). */
  "login_denied",
  /** Discovery, registration or the token exchange failed some other way. */
  "login_failed",
]);
export type McpLoginFailureCode = typeof McpLoginFailureCode.Type;

/** Why an `mcp.json` or `agents.json` file is not (fully) used. A missing file is not one. */
export const ConfigFileFailureCode = Schema.Literals([
  "unreadable",
  "invalid_config",
  /** Some names are not 1-32 letters, digits, _ or -; the others are used. */
  "invalid_names",
]);
export type ConfigFileFailureCode = typeof ConfigFileFailureCode.Type;

/** The `RUN_ERROR` code of a request that did not fit the model's context window, compacted. */
export const contextLimitExceededCode = "context_limit_exceeded";

/**
 * The `code` of a chat run's `RUN_ERROR`. An external agent's turn names its own failure; any
 * other code, including codes saved by older versions, is shown as `run_failed`.
 */
export const RunFailureCode = Schema.Literals([
  ...ExternalAgentFailureCode.literals,
  "worker_execution_failed",
  /** The run's output could not be recorded, so the page stopped receiving it. */
  "run_record_failed",
  /** The model kept repeating a tool call whose result could not change. */
  "repeated_tool_call",
  contextLimitExceededCode,
  "run_failed",
]);
export type RunFailureCode = typeof RunFailureCode.Type;

const decodeRunFailureCode = Schema.decodeUnknownOption(RunFailureCode);

/** A `RUN_ERROR` code as the page and the editor word it; unknown and missing codes are general. */
export const runFailureCodeOf = (code: string | undefined): RunFailureCode =>
  Option.getOrElse(decodeRunFailureCode(code), () => "run_failed" as const);

/** What people read for each external agent failure; the detail adds the agent's own text. */
export const externalAgentFailureText = runtimeCopy.externalAgentFailure;

/** What people read when a run ends with an error. */
export const runFailureText = runtimeCopy.runFailure;
