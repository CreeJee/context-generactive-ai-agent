import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Match } from "effect";
import type { AttemptFailure, AttemptFailureStage } from "memory-agent";

const stageLabel = {
  start: msg({ message: "시작 중", comment: "Stage of an agent run at which it failed" }),
  model: msg({ message: "모델 응답 중", comment: "Stage of an agent run at which it failed" }),
  tool: msg({ message: "도구 실행 중", comment: "Stage of an agent run at which it failed" }),
  approval: msg({ message: "승인 대기 중", comment: "Stage of an agent run at which it failed" }),
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
  }),
);

/** One line for the user: what went wrong and at which stage. Only the recorded code is shown. */
export const failureLabel = (failure: AttemptFailure) =>
  `${reasonLabel(failure.reason)} · ${i18n._(stageLabel[failure.stage])}`;
