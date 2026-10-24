import { Match } from "effect";
import type { AttemptFailure, AttemptFailureStage } from "memory-agent";

const stageLabel: Readonly<Record<AttemptFailureStage, string>> = {
  start: "시작 중",
  model: "모델 응답 중",
  tool: "도구 실행 중",
  approval: "승인 대기 중",
  finish: "결과 저장 중",
  process: "프로세스 실행 중",
  restart: "서버 재시작 중",
};

const reasonLabel = Match.type<AttemptFailure["reason"]>().pipe(
  Match.tagsExhaustive({
    ModelRunError: () => "모델이 오류를 보냈어요",
    ModelStreamFailed: () => "모델 응답 스트림이 끊겼어요",
    RepeatedToolCall: () => "결과가 바뀌지 않는 같은 도구 호출을 되풀이해서 멈췄어요",
    AgentCrashed: () => "에이전트 실행이 비정상 종료됐어요",
    HeartbeatLost: () => "에이전트가 응답을 멈췄어요",
    ServerRestarted: () => "서버가 다시 시작돼 실행이 멈췄어요",
    ExternalAgentFailed: ({ code }) => `외부 에이전트가 실패했어요 (${code})`,
    ProcessExited: ({ exitCode, signal }) =>
      signal === null
        ? `프로세스가 종료 코드 ${exitCode ?? "?"}로 끝났어요`
        : `프로세스가 ${signal} 신호로 종료됐어요`,
    ProcessTimedOut: () => "프로세스가 시간 제한을 넘었어요",
    OperationFailed: () => "작업이 결과 없이 실패했어요",
    ResultStorageFailed: () => "결과를 저장하지 못했어요",
  }),
);

/** One line for the user: what went wrong and at which stage. Only the recorded code is shown. */
export const failureLabel = (failure: AttemptFailure) =>
  `${reasonLabel(failure.reason)} · ${stageLabel[failure.stage]}`;
