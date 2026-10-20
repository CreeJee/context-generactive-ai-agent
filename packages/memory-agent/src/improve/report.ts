import type { ReportedItem } from "./discovery.ts";
import { ItemInterpretation } from "./interpret.ts";

/** What each kind of item asks to change when the model could not read it. */
const changeOf: Record<ReportedItem["source"], string> = {
  correction:
    "사용자가 같은 내용을 반복해서 정정했다. 정정된 동작이 다시 나오지 않게 코드를 고치고, 저장소의 에이전트 지침 파일(`AGENTS.md`·`CLAUDE.md` 등)에 그 규칙을 추가한다.",
  tool_failure:
    "같은 원인으로 도구 호출이 반복해서 실패했다. 실패 원인을 코드·스크립트·설정에서 없애고, 에이전트 지침 파일에 올바른 사용법을 추가한다.",
  card_failure:
    "칸반 카드가 반복해서 실패하거나 다시 계획됐다. 실패 원인을 코드에서 고치고, 같은 작업을 할 때 지킬 점을 에이전트 지침 파일에 추가한다.",
};

const sourceLabel: Record<ReportedItem["source"], string> = {
  correction: "반복된 정정",
  tool_failure: "반복된 도구 실패",
  card_failure: "칸반 카드 실패",
};

const failureLabel: Record<"model_failed" | "invalid_answer", string> = {
  model_failed: "모델이 답하지 않았다",
  invalid_answer: "모델의 답을 읽을 수 없었다",
};

/** Quoted so user text cannot open headings, lists or fences of its own. */
const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** One line, so model or user text cannot start a heading or list item of its own. */
const line = (text: string) => text.replaceAll("\n", " ");

const constraints =
  "- **Constraints:** 아래 근거와 관계없는 동작은 바꾸지 않는다. 저장소의 기존 검사와 테스트가 계속 통과해야 한다.";
const ownership =
  "- **Ownership:** 이 저장소의 새 브랜치에서만 작업한다. merge·push는 사람이 검토한 뒤에 한다.";

const specOf = (repository: string, item: ReportedItem) =>
  ItemInterpretation.match(item.interpretation, {
    interpreted: ({ problem, rule, change, acceptance }) => [
      `- **Problem:** ${line(problem)}`,
      `- **Target:** \`${repository}\`의 관련 코드와 에이전트 지침 파일(\`AGENTS.md\`·\`CLAUDE.md\` 등).`,
      `- **Change:** 지침 파일에 다음 규칙을 추가한다: ${line(rule)} 코드: ${line(change)}`,
      constraints,
      ownership,
      `- **Acceptance:** ${line(acceptance)}`,
    ],
    failed: ({ reason }) => [
      `- **Note:** 이 항목은 해석하지 못했다(${failureLabel[reason]}). 근거를 직접 읽고 판단한다.`,
      `- **Target:** \`${repository}\`의 관련 코드와 에이전트 지침 파일.`,
      `- **Change:** ${changeOf[item.source]}`,
      constraints,
      ownership,
      "- **Acceptance:** 근거의 상황이 다시 일어나지 않음을 보이는 테스트나 실행 결과, 지침 파일에 추가한 규칙, 통과한 검사 결과.",
    ],
  });

/** The item's name: the model's title when it read the item, otherwise the grouping label. */
export const reportedTitle = (item: ReportedItem) =>
  ItemInterpretation.match(item.interpretation, {
    interpreted: ({ title }) => title,
    failed: () => item.title,
  });

const itemSection = (repository: string, item: ReportedItem, index: number) =>
  [
    `## ${index + 1}. ${line(reportedTitle(item))}`,
    "",
    `- 종류: ${sourceLabel[item.source]} (${item.count}회)`,
    ...(item.latestAt === null ? [] : [`- 마지막 발생: ${item.latestAt}`]),
    `- 항목 id: \`${item.id}\``,
    "",
    "### 작업 명세",
    "",
    ...specOf(repository, item),
    "",
    "### 근거",
    "",
    ...item.excerpts.flatMap((excerpt) => [quote(excerpt), ""]),
  ].join("\n");

/** One repository's improvement items as a document another agent or tool can act on. */
export const improvementReport = (
  found: { readonly repository: string; readonly items: readonly ReportedItem[] },
  generatedAt: string,
) =>
  [
    `# 개선 항목: ${found.repository}`,
    "",
    `${generatedAt}에 이 저장소의 최근 사용 기록에서 찾은 개선 항목이다. 항목마다 작업 명세를 그대로 에이전트에게 넘길 수 있다.`,
    "",
    ...(found.items.length === 0
      ? ["고칠 만한 반복된 정정이나 실패가 없다.", ""]
      : found.items.map((item, index) => itemSection(found.repository, item, index))),
  ].join("\n");
