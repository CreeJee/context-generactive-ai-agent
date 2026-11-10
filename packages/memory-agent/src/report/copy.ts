/** Copy for problem reports a developer or the user reads. Checked by tools/copy-check. */
export const reportCopy = {
  bundle: {
    /** Stands in for a bundle text whose secrets could not be checked. */
    withheld: "[비밀정보 확인 실패로 숨김]",
  },
  /** A runtime defect message sent to the developer's Discord. */
  defect: {
    heading: (tag: string, location: string, count: number) =>
      `[결함] ${tag} @ ${location} ×${count}`,
    build: (release: string, platform: string) => `버전 ${release} · ${platform}`,
    summary: (summary: string) => `요약: ${summary}`,
    failedSpans: (lines: string) => `실패 span:\n${lines}`,
  },
  delivery: {
    /** The inline part of a report too long for one Discord message. */
    preview: (start: string) => `${start}\n…(전체 내용은 첨부 파일)`,
  },
};
