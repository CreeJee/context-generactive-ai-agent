import type { ExternalAgentFailureCode, RunFailureCode } from "./shown-failure.ts";

const externalAgentFailure = {
  missing_env: "외부 에이전트 설정이 쓰는 환경 변수가 없습니다.",
  spawn_failed: "외부 에이전트를 시작하지 못했습니다.",
  initialize_timed_out: "외부 에이전트가 제시간에 연결에 답하지 않았습니다.",
  agent_error: "외부 에이전트가 오류로 답했습니다.",
  connection_failed: "외부 에이전트에 연결하지 못했습니다.",
  session_failed: "외부 에이전트의 대화를 시작하지 못했습니다.",
  not_trusted: "신뢰한 외부 에이전트가 아닙니다. 설정에서 신뢰해 주십시오.",
  stopped_after_failures:
    "외부 에이전트가 두 번 연달아 실패해서 멈췄습니다. 설정에서 다시 연결해 주십시오.",
  disconnected: "외부 에이전트 연결이 끊겼습니다. 보낸 요청은 다시 보내지 않았습니다.",
} as const satisfies Record<ExternalAgentFailureCode, string>;

/** Copy for failures of outside programs and chat runs as people see them. Checked by lint/wording. */
export const runtimeCopy = {
  /** What people read for each external agent failure; the detail adds the agent's own text. */
  externalAgentFailure,
  /** What people read when a run ends with an error. */
  runFailure: {
    ...externalAgentFailure,
    worker_execution_failed: "에이전트 실행이 실패했습니다. 이 실행은 자동으로 다시 하지 않습니다.",
    run_record_failed:
      "응답을 기록하지 못해 이 화면으로 더 보내지 못했습니다. 실행은 계속될 수 있으니 보드와 작업 기록을 확인해 주십시오.",
    repeated_tool_call:
      "모델이 결과가 바뀌지 않는 같은 도구 호출을 계속 되풀이해서 실행을 멈췄습니다. 요청을 바꿔서 다시 보내 주십시오.",
    context_limit_exceeded:
      "대화를 줄여도 모델의 컨텍스트 창에 들어가지 않아 요청을 보내지 않았습니다. /compact로 줄이거나 설정에서 창 크기를 확인해 주십시오.",
    run_failed: "응답하는 중에 오류가 났습니다.",
  } as const satisfies Record<RunFailureCode, string>,
};
