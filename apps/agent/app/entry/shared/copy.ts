/** Copy for the shared UI pieces: theme picker, loop health and failure details. Checked by lint/wording. */
export const sharedCopy = {
  theme: {
    options: {
      system: "시스템 테마",
      light: "라이트 모드",
      dark: "다크 모드",
    },
    current: (label: string) => `화면 테마: ${label}`,
  },
  loopHealth: {
    status: {
      Healthy: "정상",
      Retrying: (attempt: number, of: number) => `재시도 중 ${attempt}/${of}`,
      Exhausted: "재시도 소진",
      Defected: "결함으로 중단",
    },
    restart: "다시 시작",
  },
  failureDetails: {
    toggle: "자세히",
  },
};
