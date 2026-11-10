import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Match } from "effect";
import type { AttemptFailure, AttemptFailureStage } from "memory-agent";

const stageLabel = {
  start: msg({ message: "시작 중", comment: "Stage of an agent run at which it failed" }),
  model: msg({ message: "모델 응답 중", comment: "Stage of an agent run at which it failed" }),
  tool: msg({ message: "도구 실행 중", comment: "Stage of an agent run at which it failed" }),
  approval: msg({ message: "승인 대기 중", comment: "Stage of an agent run at which it failed" }),
  finish: msg({ message: "결과 저장 중", comment: "Stage of an agent run at which it failed" }),
  process: msg({
    message: "프로세스 실행 중",
    comment: "Stage of an agent run at which it failed",
  }),
  restart: msg({ message: "서버 재시작 중", comment: "Stage of an agent run at which it failed" }),
} satisfies Readonly<Record<AttemptFailureStage, MessageDescriptor>>;

const reasonLabel = Match.type<AttemptFailure["reason"]>().pipe(
  Match.tagsExhaustive({
    ModelRunError: () => t`모델이 오류를 보냈습니다`,
    ModelStreamFailed: () => t`모델 응답 스트림이 끊겼습니다`,
    RepeatedToolCall: () => t`결과가 바뀌지 않는 같은 도구 호출을 되풀이해서 멈췄습니다`,
    ContextLimitExceeded: () => t`줄여도 모델의 컨텍스트 창을 넘어서 멈췄습니다`,
    AgentCrashed: () => t`에이전트 실행이 비정상 종료됐습니다`,
    HeartbeatLost: () => t`에이전트가 응답을 멈췄습니다`,
    ServerRestarted: () => t`서버가 다시 시작돼 실행이 멈췄습니다`,
    ExternalAgentFailed: ({ code }) =>
      t({
        message: `외부 에이전트가 실패했습니다 (${code})`,
        comment: "{code} is the failure code the external coding agent reported",
      }),
    ProcessExited: ({ exitCode, signal }) => {
      const code = exitCode ?? "?";
      return signal === null
        ? t({
            message: `프로세스가 종료 코드 ${code}로 끝났습니다`,
            comment: "{code} is the process exit code, or ? when it is unknown",
          })
        : t({
            message: `프로세스가 ${signal} 신호로 종료됐습니다`,
            comment: "{signal} is the operating system signal name, such as SIGTERM",
          });
    },
    ProcessTimedOut: () => t`프로세스가 시간 제한을 넘었습니다`,
    OperationFailed: () => t`작업이 결과 없이 실패했습니다`,
    ResultStorageFailed: () => t`결과를 저장하지 못했습니다`,
  }),
);

/** One line for the user: what went wrong and at which stage. Only the recorded code is shown. */
export const failureLabel = (failure: AttemptFailure) =>
  `${reasonLabel(failure.reason)} · ${i18n._(stageLabel[failure.stage])}`;
