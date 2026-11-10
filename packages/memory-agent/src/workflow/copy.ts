/** Copy for why a Goal run's automatic execution stopped. Checked by tools/copy-check. */
export const workflowCopy = {
  /** Blocker details the run state shows, keyed by the situation that blocked the run. */
  blocked: {
    serverRestarted:
      "결과가 확인되지 않은 도구 실행 중 서버가 다시 시작돼 자동으로 이어가지 않았습니다. 실행 결과를 확인한 뒤 다시 보내 주십시오.",
    providerRetryExhausted:
      "공급자에 요청을 보내지 못하는 상태가 이어져 자동 재시도를 멈췄습니다. 네트워크와 공급자 연결을 확인한 뒤 다시 보내 주십시오.",
  },
};
