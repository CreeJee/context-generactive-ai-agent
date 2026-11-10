/**
 * Messages the app sends to the model in the user's voice. They are not UI copy, so
 * tools/copy-check does not read them; whether prompts follow the copy rules is still open
 * (docs/decisions.md, "앱 문구는 copy.ts 카탈로그에 두고 …").
 */
export const chatPrompts = {
  /** Sent when a paused Goal resumes. */
  resumeGoal: "일시 중지한 Goal을 현재 상태에서 이어서 진행해 줘.",
  /** Sent by `/plan` without a request. */
  planDefault: "요청에서 목표를 정리하고 실행 가능한 Plan을 읽기 전용으로 조사해 기록해 줘.",
  /** Sent by `/skill`; the user's request follows on its own paragraph. */
  skill: (skill: string, request: string) =>
    `"${skill}" skill을 read_skill로 읽고 그 지침대로 해 주세요.${request.length > 0 ? `\n\n${request}` : ""}`,
  /** Sent by `/recall`. */
  recall: (question: string) =>
    `find_memory로 기억을 찾아서, 출처(프로젝트와 시점)와 나중에 바뀐 결정이 있으면 함께 답해 주세요: ${question}`,
};
