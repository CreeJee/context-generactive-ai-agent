import type { AttemptFailureStage, ExternalAgentFailureCode } from "memory-agent";

/** Copy for chat session state: run notices, failure lines and delegated work. Checked by tools/copy-check. */
export const sessionCopy = {
  attemptFailure: {
    stage: {
      start: "시작 중",
      model: "모델 응답 중",
      tool: "도구 실행 중",
      approval: "승인 대기 중",
      finish: "결과 저장 중",
      process: "프로세스 실행 중",
      restart: "서버 재시작 중",
    } satisfies Readonly<Record<AttemptFailureStage, string>>,
    reason: {
      ModelRunError: "모델이 오류를 보냈습니다",
      ModelStreamFailed: "모델 응답 스트림이 끊겼습니다",
      RepeatedToolCall: "결과가 바뀌지 않는 같은 도구 호출을 되풀이해서 멈췄습니다",
      ContextLimitExceeded: "줄여도 모델의 컨텍스트 창을 넘어서 멈췄습니다",
      AgentCrashed: "에이전트 실행이 비정상 종료됐습니다",
      HeartbeatLost: "에이전트가 응답을 멈췄습니다",
      ServerRestarted: "서버가 다시 시작돼 실행이 멈췄습니다",
      ExternalAgentFailed: (code: ExternalAgentFailureCode) =>
        `외부 에이전트가 실패했습니다 (${code})`,
      ProcessExited: {
        exitCode: (exitCode: number | null) =>
          `프로세스가 종료 코드 ${exitCode ?? "?"}로 끝났습니다`,
        signal: (signal: string) => `프로세스가 ${signal} 신호로 종료됐습니다`,
      },
      ProcessTimedOut: "프로세스가 시간 제한을 넘었습니다",
      OperationFailed: "작업이 결과 없이 실패했습니다",
      ResultStorageFailed: "결과를 저장하지 못했습니다",
    },
  },
  backgroundKind: {
    externalAgent: "외부 에이전트",
    shell: "셸 명령",
  },
  requester: {
    namedSubagent: (name: string) => `서브에이전트 ${name}`,
    subagent: "서브에이전트",
    externalAgent: (agent: string) => `외부 에이전트 ${agent}`,
  },
  unknownError: "알 수 없는 오류",
  runNotice: {
    cancelled: "답변을 멈췄습니다.",
    cancelPending: {
      title: "멈추기를 요청했습니다",
      body: "서버에서 아직 멈추지 않았습니다. 멈추면 여기에 표시됩니다.",
    },
    restarted: {
      title: "마지막 답변이 끝나지 않았습니다",
      body: "답변 중에 서버가 다시 시작됐습니다. 자동으로 다시 실행하지 않습니다. 필요하면 다시 보내 주십시오.",
    },
    resuming: {
      title: "마지막 답변이 끝나지 않았습니다",
      body: (at: string) =>
        `답변 중에 서버가 다시 시작됐습니다. 도구를 실행하기 전이라 같은 요청을 ${at}에 새 실행으로 이어서 진행합니다.`,
    },
    failed: { title: "마지막 답변이 실패했습니다" },
    detached: {
      title: "답변이 아직 진행 중입니다",
      body: "이 페이지와 연결이 끊겼지만 서버에서는 계속 답하고 있습니다. 다시 연결하면 이어서 볼 수 있습니다.",
      reconnect: "다시 연결",
    },
    stopped: {
      title: "답변이 중간에 멈췄습니다",
      body: "끝까지 답하지 못했습니다. 필요하면 다시 보내 주십시오.",
    },
    noAnswer: {
      title: "답변 글 없이 끝났습니다",
      body: "모델이 도구만 쓰고 답을 쓰지 않은 채 마쳤습니다. 이어서 답해 달라고 다시 보내 주십시오.",
    },
    reconciled: {
      title: "앱이 상태를 고쳤습니다",
      body: "이전 버전이 끝내지 못한 Goal 상태를 고치고 자동 실행을 멈췄습니다. 이어서 하려면 메시지를 보내 주십시오.",
    },
  },
};
