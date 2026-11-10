import type { ItemInterpretation, ReportedItem } from "./contracts.ts";

/**
 * Text a coding agent reads: the improvement report is a task spec the user hands to an agent of
 * their choice, and the excerpts also go to the interpretation model. Not UI copy, so
 * tools/copy-check does not read it.
 */
export const improvePrompts = {
  /** One correction as evidence: what the user wrote, then what it corrected. */
  correctionExcerpt: (text: string, corrected: string) => `${text}\n— 정정 대상: ${corrected}`,
  report: {
    heading: (repository: string) => `# 개선 항목: ${repository}`,
    intro: (generatedAt: string) =>
      `${generatedAt}에 이 저장소의 최근 사용 기록에서 찾은 개선 항목이다. 항목마다 작업 명세를 그대로 에이전트에게 넘길 수 있다.`,
    empty: "고칠 만한 반복된 정정이나 실패가 없다.",
    item: {
      kind: (label: string, count: number) => `- 종류: ${label} (${count}회)`,
      latestAt: (at: string) => `- 마지막 발생: ${at}`,
      id: (id: string) => `- 항목 id: \`${id}\``,
      spec: "### 작업 명세",
      evidence: "### 근거",
    },
    spec: {
      target: (repository: string) =>
        `- **Target:** \`${repository}\`의 관련 코드와 에이전트 지침 파일(\`AGENTS.md\`·\`CLAUDE.md\` 등).`,
      change: (rule: string, change: string) =>
        `- **Change:** 지침 파일에 다음 규칙을 추가한다: ${rule} 코드: ${change}`,
      constraints:
        "- **Constraints:** 아래 근거와 관계없는 동작은 바꾸지 않는다. 저장소의 기존 검사와 테스트가 계속 통과해야 한다.",
      ownership:
        "- **Ownership:** 이 저장소의 새 브랜치에서만 작업한다. merge·push는 사람이 검토한 뒤에 한다.",
    },
    /** The spec of an item the model could not read. */
    uninterpreted: {
      note: (failure: string) =>
        `- **Note:** 이 항목은 해석하지 못했다(${failure}). 근거를 직접 읽고 판단한다.`,
      target: (repository: string) =>
        `- **Target:** \`${repository}\`의 관련 코드와 에이전트 지침 파일.`,
      /** What each kind of item asks to change. */
      change: {
        correction:
          "사용자가 같은 내용을 반복해서 정정했다. 정정된 동작이 다시 나오지 않게 코드를 고치고, 저장소의 에이전트 지침 파일(`AGENTS.md`·`CLAUDE.md` 등)에 그 규칙을 추가한다.",
        tool_failure:
          "같은 원인으로 도구 호출이 반복해서 실패했다. 실패 원인을 코드·스크립트·설정에서 없애고, 에이전트 지침 파일에 올바른 사용법을 추가한다.",
        card_failure:
          "칸반 카드가 반복해서 실패하거나 다시 계획됐다. 실패 원인을 코드에서 고치고, 같은 작업을 할 때 지킬 점을 에이전트 지침 파일에 추가한다.",
      } satisfies Record<ReportedItem["source"], string>,
      failure: {
        model_failed: "모델이 답하지 않았다",
        invalid_answer: "모델의 답을 읽을 수 없었다",
      } satisfies Record<Extract<ItemInterpretation, { _tag: "failed" }>["reason"], string>,
      acceptance:
        "- **Acceptance:** 근거의 상황이 다시 일어나지 않음을 보이는 테스트나 실행 결과, 지침 파일에 추가한 규칙, 통과한 검사 결과.",
    },
  },
};
