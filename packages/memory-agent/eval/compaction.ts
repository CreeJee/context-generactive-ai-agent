import type { ModelMessage } from "@tanstack/ai";
import {
  recentRawUserTurns,
  retrievalTokenLimit,
  summaryBlockTurns,
} from "../src/agent/compaction-policy.ts";
import {
  compact,
  estimateConversation,
  estimateTokens,
  messageText,
  type CompactionState,
  type SummaryBlock,
} from "../src/agent/compaction.ts";

const legacyBlockTurns = 10;
const legacyRecentTurns = 4;
const fixedPrefixTokens = 2_000;
const checkpoints = [16, 20, 26] as const;

interface ProfileResult {
  readonly name: string;
  readonly averageInputTokens: number;
  readonly averageCacheableRatio: number;
  readonly summaryCalls: number;
  readonly mainCalls: number;
  readonly providerCalls: number;
}

export interface CompactionEvaluation {
  readonly legacy: ProfileResult;
  readonly current: ProfileResult;
  readonly inputTokenReduction: number;
  readonly cacheableRatioGain: number;
  readonly evidenceReachRate: number;
  readonly correctionAppliedRate: number;
  readonly retrievalTokens: number;
  readonly thresholds: {
    readonly inputTokensReduced: boolean;
    readonly cacheableRatioImproved: boolean;
    readonly evidenceReached: boolean;
    readonly correctionApplied: boolean;
    readonly retrievalWithinBudget: boolean;
  };
}

const userText = (turn: number) => {
  if (turn === 3)
    return `배포 창은 화요일 오후로 정한다. original-decision ${"초기 결정 설명 ".repeat(35)}`;
  if (turn === 14)
    return `앞 결정을 정정한다. 배포 창은 목요일 오후로 바꾼다. corrected-decision ${"정정 근거 ".repeat(35)}`;
  if (turn === 26) return "최종 배포 창과 그 근거를 원문에서 확인해 줘.";
  return `장기 대화 질문 ${turn}. ${"구현 세부사항과 검증 결과를 기록한다. ".repeat(35)}`;
};

const answerText = (turn: number) =>
  `장기 대화 답변 ${turn}. ${"확인한 파일과 테스트 결과를 설명한다. ".repeat(28)}`;

function conversation(turns: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push({ role: "user", content: userText(turn) });
    if (turn === turns) continue;
    if (turn === 1) {
      messages.push(
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "long-tool",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"large.log"}' },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "long-tool",
          content: `대형 도구 결과 ${"빌드 및 테스트 로그 ".repeat(1_000)}`,
        },
      );
    }
    messages.push({ role: "assistant", content: answerText(turn) });
  }
  return messages;
}

const userIndexes = (messages: readonly ModelMessage[]) =>
  messages.flatMap((message, index) => (message.role === "user" ? [index] : []));

function legacyRequest(messages: readonly ModelMessage[]): ModelMessage[] {
  const turns = userIndexes(messages);
  const eligible = Math.max(0, turns.length - legacyRecentTurns);
  const summarized = Math.floor(eligible / legacyBlockTurns) * legacyBlockTurns;
  const firstKept = turns[summarized];
  if (summarized === 0 || firstKept === undefined) return [...messages];
  return [
    {
      role: "assistant",
      content: `[Legacy combined summary rewritten through user turn ${summarized}. ${summarized >= 14 ? "The deployment window is Thursday afternoon." : "The deployment window is Tuesday afternoon."}]`,
    },
    ...messages.slice(firstKept),
  ];
}

const nodeId = (turn: number) => `node-user-${turn}`;
const nodeText = (id: string) => {
  const turn = Number(id.replace("node-user-", ""));
  return Number.isInteger(turn) && turn > 0 ? userText(turn) : null;
};

function summaryBlocks(turns: number): SummaryBlock[] {
  const through = turns - recentRawUserTurns;
  const blocks: SummaryBlock[] = [];
  for (let end = summaryBlockTurns; end <= through; end += summaryBlockTurns) {
    const decision =
      end < 14 ? "배포 창은 화요일 오후라는 초기 결정" : "배포 창은 목요일 오후라는 최신 정정";
    blocks.push({
      end,
      nextTurnNodeId: nodeId(end + 1),
      text: `- ${decision}을 포함해 ${end - summaryBlockTurns + 1}-${end}턴을 요약했다. (node ${nodeId(end)})`,
    });
  }
  return blocks;
}

const retrieval = {
  role: "assistant" as const,
  content:
    "[Retrieval appendix for content omitted from this request. Leads require read_evidence and trace_evidence.]\n" +
    `- node ${nodeId(14)} (current session · user): ${userText(14)}`,
};

async function currentRequest(messages: readonly ModelMessage[]): Promise<ModelMessage[]> {
  const state: CompactionState = {
    manual: { clearedThrough: 0, summarizedTurns: 0 },
    blocks: summaryBlocks(userIndexes(messages).length),
  };
  const result = await compact(
    messages,
    state,
    {
      toolResultIds: () => new Map([["long-tool", "node-tool-result"]]),
      nodeText,
      retrievalAppendix: async () => retrieval,
    },
    { compactAt: 1, leaveOutAt: 1_000_000 },
  );
  return [...result.messages];
}

const sameMessage = (left: ModelMessage, right: ModelMessage) =>
  JSON.stringify(left) === JSON.stringify(right);

function commonPrefixTokens(previous: readonly ModelMessage[], current: readonly ModelMessage[]) {
  let count = 0;
  while (
    count < previous.length &&
    count < current.length &&
    sameMessage(previous[count]!, current[count]!)
  )
    count++;
  return estimateConversation(current.slice(0, count));
}

function profile(
  name: string,
  requests: readonly (readonly ModelMessage[])[],
  summaryCalls: number,
): ProfileResult {
  const input = requests.map((request) => fixedPrefixTokens + estimateConversation(request));
  const ratios = requests.slice(1).map((request, index) => {
    const cached = fixedPrefixTokens + commonPrefixTokens(requests[index]!, request);
    return cached / (fixedPrefixTokens + estimateConversation(request));
  });
  const mainCalls = requests.length;
  return {
    name,
    averageInputTokens: Math.round(input.reduce((sum, value) => sum + value, 0) / input.length),
    averageCacheableRatio: ratios.reduce((sum, value) => sum + value, 0) / ratios.length,
    summaryCalls,
    mainCalls,
    providerCalls: mainCalls + summaryCalls,
  };
}

export async function evaluateCompaction(): Promise<CompactionEvaluation> {
  const conversations = checkpoints.map(conversation);
  const legacyRequests = conversations.map(legacyRequest);
  const currentRequests = await Promise.all(conversations.map(currentRequest));
  const final = currentRequests.at(-1) ?? [];
  const appendix = final.find((message) => messageText(message).startsWith("[Retrieval appendix"));
  const appendixText = appendix ? messageText(appendix) : "";
  const retrievalTokens = appendix ? estimateTokens(appendix) : 0;
  const evidenceReachRate = appendixText.includes(nodeId(14)) ? 1 : 0;
  const correctionAppliedRate =
    appendixText.includes("목요일 오후") && !appendixText.includes(nodeId(3)) ? 1 : 0;
  const legacy = profile(
    "legacy-conservative (10-turn combined summary, 4 raw turns, no retrieval)",
    legacyRequests,
    Math.floor((checkpoints.at(-1)! - legacyRecentTurns) / legacyBlockTurns),
  );
  const current = profile(
    "current-aggressive (4-turn immutable blocks, 2 raw turns, bounded retrieval)",
    currentRequests,
    Math.floor((checkpoints.at(-1)! - recentRawUserTurns) / summaryBlockTurns),
  );
  const inputTokenReduction =
    (legacy.averageInputTokens - current.averageInputTokens) / legacy.averageInputTokens;
  const cacheableRatioGain = current.averageCacheableRatio - legacy.averageCacheableRatio;
  return {
    legacy,
    current,
    inputTokenReduction,
    cacheableRatioGain,
    evidenceReachRate,
    correctionAppliedRate,
    retrievalTokens,
    thresholds: {
      inputTokensReduced: inputTokenReduction > 0,
      cacheableRatioImproved: cacheableRatioGain > 0,
      evidenceReached: evidenceReachRate === 1,
      correctionApplied: correctionAppliedRate === 1,
      retrievalWithinBudget: retrievalTokens <= retrievalTokenLimit,
    },
  };
}
