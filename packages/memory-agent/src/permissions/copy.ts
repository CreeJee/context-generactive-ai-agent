/** Copy for why a tool call was allowed, asked about or decided. Checked by tools/copy-check. */
export const permissionsCopy = {
  /** Reasons the permission review gives without asking the model. */
  review: {
    downloadingRunner:
      "npx·pnpx는 패키지가 없으면 내려받아 실행할 수 있습니다. 이미 설치된 프로젝트 패키지만 실행하려면 pnpm exec 또는 npm exec --를 사용해 주십시오.",
    routineAllowed: "일반적인 프로젝트 개발 명령이라 자동 허용했습니다.",
    unavailable: "자동 판단을 받지 못해서 직접 확인이 필요합니다.",
  },
  /** Asked of the user when no review ran: the tool needs a decision on every call. */
  askEveryCall: "호출할 때마다 확인하는 도구입니다.",
  /** The recorded reason of the user's answer. */
  answered: {
    approved: "사용자가 승인했습니다.",
    denied: "사용자가 거부했습니다.",
  },
};
