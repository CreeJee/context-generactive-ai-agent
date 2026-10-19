import type { ImprovementItem } from "./items.ts";
import type { RepositoryImprovements } from "./discovery.ts";

/** What each kind of item asks to change; every change pairs code with the agent guidance. */
const changeOf: Record<ImprovementItem["source"], string> = {
  correction:
    "사용자가 같은 내용을 반복해서 정정했다. 정정된 동작이 다시 나오지 않게 코드를 고치고, 저장소의 에이전트 지침 파일(`AGENTS.md`·`CLAUDE.md` 등)에 그 규칙을 추가한다.",
  tool_failure:
    "같은 원인으로 도구 호출이 반복해서 실패했다. 실패 원인을 코드·스크립트·설정에서 없애고, 에이전트 지침 파일에 올바른 사용법을 추가한다.",
  card_failure:
    "칸반 카드가 반복해서 실패하거나 다시 계획됐다. 실패 원인을 코드에서 고치고, 같은 작업을 할 때 지킬 점을 에이전트 지침 파일에 추가한다.",
};

const sourceLabel: Record<ImprovementItem["source"], string> = {
  correction: "반복된 정정",
  tool_failure: "반복된 도구 실패",
  card_failure: "칸반 카드 실패",
};

/** Quoted so user text cannot open headings, lists or fences of its own. */
const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

const itemSection = (repository: string, item: ImprovementItem, index: number) =>
  [
    `## ${index + 1}. ${item.title.replaceAll("\n", " ")}`,
    "",
    `- 종류: ${sourceLabel[item.source]} (${item.count}회)`,
    ...(item.latestAt === null ? [] : [`- 마지막 발생: ${item.latestAt}`]),
    `- 항목 id: \`${item.id}\``,
    "",
    "### 작업 명세",
    "",
    `- **Target:** \`${repository}\`의 관련 코드와 에이전트 지침 파일.`,
    `- **Change:** ${changeOf[item.source]}`,
    "- **Constraints:** 아래 근거와 관계없는 동작은 바꾸지 않는다. 저장소의 기존 검사와 테스트가 계속 통과해야 한다.",
    "- **Ownership:** 이 저장소의 새 브랜치에서만 작업한다. merge·push는 사람이 검토한 뒤에 한다.",
    "- **Acceptance:** 근거의 상황이 다시 일어나지 않음을 보이는 테스트나 실행 결과, 지침 파일에 추가한 규칙, 통과한 검사 결과.",
    "",
    "### 근거",
    "",
    ...item.excerpts.flatMap((excerpt) => [quote(excerpt), ""]),
  ].join("\n");

/** One repository's improvement items as a document another agent or tool can act on. */
export const improvementReport = (found: RepositoryImprovements, generatedAt: string) =>
  [
    `# 개선 항목: ${found.repository}`,
    "",
    `${generatedAt}에 이 저장소의 최근 사용 기록에서 찾은 개선 항목이다. 항목마다 작업 명세를 그대로 에이전트에게 넘길 수 있다.`,
    "",
    ...(found.items.length === 0
      ? ["반복된 정정이나 실패가 없어 개선 항목이 없다.", ""]
      : found.items.map((item, index) => itemSection(found.repository, item, index))),
  ].join("\n");
