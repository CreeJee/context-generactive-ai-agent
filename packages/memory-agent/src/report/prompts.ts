/**
 * Text the report diagnosis model reads in the evidence digest. Not UI copy, so lint/wording
 * does not read it.
 */
export const reportPrompts = {
  digest: {
    /** Marks a bundle text that was cut to its limit. */
    cut: (text: string) => `${text} [잘림]`,
    environment: "환경·연동·루프·결함",
    timeline: (shown: number, total: number) => `세션 타임라인 (run ${shown}/${total})`,
    failure: (place: string) => `실패 주변 ${place}`,
  },
};
