import { Option, Schema } from "effect";
import { msg } from "@lingui/core/runtime-macro";
import { i18n } from "../i18n.ts";

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
  /** The model's provider limited requests, had no quota left, refused the login or failed. */
  "provider_rate_limited",
  "provider_quota_exhausted",
  "provider_auth_failed",
  "provider_failed",
  /** The model's provider could not be reached. */
  "provider_unreachable",
  /** The user discarded approvals whose run could no longer go on; the gated tools never ran. */
  "interrupt_continuation_lost",
  "run_failed",
]);
export type RunFailureCode = typeof RunFailureCode.Type;

const decodeRunFailureCode = Schema.decodeUnknownOption(RunFailureCode);

/** A `RUN_ERROR` code as the page and the editor word it; unknown and missing codes are general. */
export const runFailureCodeOf = (code: string | undefined): RunFailureCode =>
  Option.getOrElse(decodeRunFailureCode(code), () => "run_failed" as const);

/**
 * What people read for each external agent failure; the detail adds the agent's own text.
 * Resolved when the module loads: the app's pages render it as plain text.
 */
export const externalAgentFailureText = {
  missing_env: i18n._(msg`외부 에이전트 설정이 쓰는 환경 변수가 없습니다.`),
  spawn_failed: i18n._(msg`외부 에이전트를 시작하지 못했습니다.`),
  initialize_timed_out: i18n._(msg`외부 에이전트가 제시간에 연결에 답하지 않았습니다.`),
  agent_error: i18n._(msg`외부 에이전트가 오류로 답했습니다.`),
  connection_failed: i18n._(msg`외부 에이전트에 연결하지 못했습니다.`),
  session_failed: i18n._(msg`외부 에이전트의 대화를 시작하지 못했습니다.`),
  not_trusted: i18n._(msg`신뢰한 외부 에이전트가 아닙니다. 설정에서 신뢰해 주십시오.`),
  stopped_after_failures: i18n._(
    msg`외부 에이전트가 두 번 연달아 실패해서 멈췄습니다. 설정에서 다시 연결해 주십시오.`,
  ),
  disconnected: i18n._(msg`외부 에이전트 연결이 끊겼습니다. 보낸 요청은 다시 보내지 않았습니다.`),
} satisfies Readonly<Record<ExternalAgentFailureCode, string>>;

/** What people read when a run ends with an error. Resolved when the module loads, as above. */
export const runFailureText = {
  ...externalAgentFailureText,
  worker_execution_failed: i18n._(
    msg`에이전트 실행이 실패했습니다. 이 실행은 자동으로 다시 하지 않습니다.`,
  ),
  run_record_failed: i18n._(
    msg`응답을 기록하지 못해 이 화면으로 더 보내지 못했습니다. 실행은 계속될 수 있으니 보드와 작업 기록을 확인해 주십시오.`,
  ),
  repeated_tool_call: i18n._(
    msg`모델이 결과가 바뀌지 않는 같은 도구 호출을 계속 되풀이해서 실행을 멈췄습니다. 요청을 바꿔서 다시 보내 주십시오.`,
  ),
  context_limit_exceeded: i18n._(
    msg`대화를 줄여도 모델의 컨텍스트 창에 들어가지 않아 요청을 보내지 않았습니다. /compact로 줄이거나 설정에서 창 크기를 확인해 주십시오.`,
  ),
  provider_rate_limited: i18n._(
    msg`공급자가 요청을 잠시 제한하고 있습니다. 잠시 뒤 다시 보내 주십시오.`,
  ),
  provider_quota_exhausted: i18n._(
    msg`공급자 계정의 사용 한도가 남지 않았습니다. 한도가 다시 차거나 다른 계정으로 바꾼 뒤 다시 보내 주십시오.`,
  ),
  provider_auth_failed: i18n._(
    msg`공급자가 로그인 정보를 받지 않았습니다. 다시 로그인한 뒤 보내 주십시오.`,
  ),
  provider_failed: i18n._(msg`공급자가 오류로 답했습니다. 잠시 뒤 다시 보내 주십시오.`),
  provider_unreachable: i18n._(
    msg`공급자에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 보내 주십시오.`,
  ),
  interrupt_continuation_lost: i18n._(
    msg`이어갈 수 없던 승인 요청을 폐기했습니다. 승인을 기다리던 작업은 실행하지 않았습니다.`,
  ),
  run_failed: i18n._(msg`응답하는 중에 오류가 났습니다.`),
} satisfies Readonly<Record<RunFailureCode, string>>;
