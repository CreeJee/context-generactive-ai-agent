/**
 * Text the session chat gives the model. It is not UI copy, so tools/copy-check does not read it
 * (docs/decisions.md, "앱 문구는 copy.ts 카탈로그에 두고 …").
 */
export const agentPrompts = {
  /** The report evidence in place of a snapshot that could not be collected. */
  reportEvidenceFailed:
    "자동 근거 수집 실패. 원본 근거를 확인한 것으로 주장하지 마세요; 읽기 도구로 재시도할 수 있습니다.",
};
