import type { ImprovementItem } from "./contracts.ts";

/** Copy for improvement items on the settings page. Checked by tools/copy-check. */
export const improveCopy = {
  /** How the app names each kind of item, in reports and on the settings page. */
  sourceLabels: {
    correction: "반복된 정정",
    tool_failure: "반복된 도구 실패",
    card_failure: "칸반 카드 실패",
  } satisfies Record<ImprovementItem["source"], string>,
};
