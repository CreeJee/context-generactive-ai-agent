import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  budgetFor,
  clearedOutput,
  compactionHook,
  estimateConversation,
  turnSummariesNamespace,
  type Budget,
} from "../../src/agent/compaction.ts";
import {
  consumeColdObservationEffect,
  contextUsageNamespace,
  pendingColdObservationEffect,
  type StoredContextUsage,
} from "../../src/agent/context-usage.ts";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import type { JsonValue } from "../../src/json.ts";
import { RunStore } from "../../src/loop/store.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { MemoryTools } from "../../src/tools/memory.ts";
import { scriptedRun } from "../support/loop-run.ts";
import { callTool } from "../support/run-tools.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { conversation, nextRequest, noLimit, sourcesOf } from "./fixtures.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Each test gets its own session in the shared agent, so nodes and metadata never leak. */
const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  return { projectId: project.id, sessionId: session.id };
});

/** Usage as any release stored it: older ones lack the observation and compaction fields. */
type LegacyUsage = Partial<StoredContextUsage>;

const metadataStore = Effect.map(RunStore, (store) => store.chatMetadata);

testAgent()("compaction over recorded history", (it) => {
  it.effect(
    "tool result lookup returns the first recorded node without materializing the session",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const nodes = yield* Nodes;
        const first = yield* nodes.append({
          ...at,
          kind: "tool_result",
          text: "first",
          detail: { toolCallId: "same-call" },
        });
        yield* nodes.append({
          ...at,
          kind: "tool_result",
          text: "second",
          detail: { toolCallId: "same-call" },
        });
        expect(yield* nodes.toolResultId(at.sessionId, "same-call")).toBe(first.id);
        expect(yield* nodes.toolResultId(at.sessionId, "missing")).toBeNull();
      }),
  );

  it.effect(
    "read_tool_result pages the saved original but refuses another conversation and other kinds",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const other = yield* freshSession;
        const nodes = yield* Nodes;
        const text = "saved original".repeat(500);
        const own = yield* nodes.append({ ...at, kind: "tool_result", text });
        const foreign = yield* nodes.append({ ...other, kind: "tool_result", text });
        const wrongKind = yield* nodes.append({ ...at, kind: "assistant", text });
        const { tools } = (yield* MemoryTools).runToolsFor({
          ...at,
          runId: `${at.sessionId}:r1`,
          userNodeId: wrongKind.id,
        });
        const read = (params: JsonValue) => callTool(tools, "read_tool_result", params);
        expect(yield* read({ id: own.id, offset: 0 })).toMatchObject({
          id: own.id,
          text: text.slice(0, 4_000),
          nextOffset: 4_000,
        });
        expect(yield* read({ id: own.id, offset: 4_000 })).toMatchObject({
          text: text.slice(4_000),
          nextOffset: null,
        });
        expect(yield* read({ id: foreign.id })).toEqual({
          error: "not_found",
          id: foreign.id,
        });
        expect(yield* read({ id: wrongKind.id })).toEqual({
          error: "not_found",
          id: wrongKind.id,
        });
      }),
  );

  it.effect("cold observation consumption persists while legacy/missing usage keeps behaving", () =>
    Effect.gen(function* () {
      const { sessionId: threadId } = yield* freshSession;
      const metadata = yield* metadataStore;
      const pending = pendingColdObservationEffect({ metadata, threadId });
      const usage = (value: LegacyUsage) => metadata.set(contextUsageNamespace, threadId, value);
      const cold = (observationId: string) =>
        usage({ inputTokens: 100, cachedTokens: 0, observationId, compactionStage: "none" });
      expect(yield* pending).toBeNull();
      yield* usage({ inputTokens: 100, cachedTokens: 0 });
      expect(yield* pending).toBeNull();
      yield* cold("first");
      expect(yield* pending).toBe("first");
      yield* consumeColdObservationEffect({ metadata, threadId, observationId: "first" });
      expect(yield* pending).toBeNull();
      yield* cold("second");
      expect(yield* pending).toBe("second");
      yield* usage({ inputTokens: 100 });
      expect(yield* pending).toBeNull();
    }),
  );

  it.effect("cold usage compacts below the normal threshold on the next request only", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const nodes = yield* Nodes;
      const metadata = yield* metadataStore;
      const { messages } = yield* conversation(nodes, at, ["one", "two", "three", "four"]);
      const sent = () => nextRequest(messages, at.sessionId);
      const usage = (value: LegacyUsage) =>
        metadata.set(contextUsageNamespace, at.sessionId, value);
      expect((yield* sent())[0]).toEqual({ role: "user", content: "질문 1" });
      yield* usage({ inputTokens: 100, cachedTokens: null });
      expect((yield* sent())[0]).toEqual({ role: "user", content: "질문 1" });
      yield* usage({ inputTokens: 100, cachedTokens: 0, observationId: "cold-1" });
      const early = yield* sent();
      expect(early[0]?.content).toContain("earlier messages of this conversation were left out");
      expect(early).toContainEqual({ role: "user", content: "질문 4" });
      expect(early.at(-1)).toEqual({ role: "user", content: "질문 5" });
      expect(yield* pendingColdObservationEffect({ metadata, threadId: at.sessionId })).toBeNull();
      // Consumption is durable: the same observation does not trigger again after the first attempt.
      expect((yield* sent())[0]).toEqual({ role: "user", content: "질문 1" });
      yield* usage({ inputTokens: 100, cachedTokens: 0, observationId: "cold-2" });
      expect((yield* sent())[0]?.content).toContain(
        "earlier messages of this conversation were left out",
      );
    }),
  );

  it.effect(
    "clears answered tool output once a later run has answered, and keeps the latest whole",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const nodes = yield* Nodes;
        const output = "빌드 로그 ".repeat(1_000);
        const lint = "린트 경고 ".repeat(200);
        yield* nodes.append({ ...at, kind: "user", text: "린트 돌려 줘" });
        yield* nodes.append({
          ...at,
          kind: "tool_call",
          text: 'run_shell {"command":"pnpm lint"}',
          detail: { toolName: "run_shell", toolCallId: "older-1" },
        });
        const lintResult = yield* nodes.append({
          ...at,
          kind: "tool_result",
          text: lint,
          detail: { toolName: "run_shell", toolCallId: "older-1", ok: true },
        });
        yield* nodes.append({ ...at, kind: "user", text: "빌드 로그 봐 줘" });
        yield* nodes.append({
          ...at,
          kind: "tool_call",
          text: 'run_shell {"command":"pnpm build"}',
          detail: { toolName: "run_shell", toolCallId: "old-1" },
        });
        const result = yield* nodes.append({
          ...at,
          kind: "tool_result",
          text: output,
          detail: { toolName: "run_shell", toolCallId: "old-1", ok: true },
        });
        const question = yield* nodes.append({ ...at, kind: "user", text: "그 로그 다시 읽어 줘" });
        const messages: StoredMessage[] = [
          { role: "user", content: "린트 돌려 줘" },
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "older-1",
                type: "function",
                function: { name: "run_shell", arguments: '{"command":"pnpm lint"}' },
              },
            ],
          },
          { role: "tool", toolCallId: "older-1", content: lint },
          { role: "assistant", content: "경고가 있어요." },
          { role: "user", content: "빌드 로그 봐 줘" },
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "old-1",
                type: "function",
                function: { name: "run_shell", arguments: '{"command":"pnpm build"}' },
              },
            ],
          },
          { role: "tool", toolCallId: "old-1", content: output },
          { role: "assistant", content: "빌드는 성공했어요." },
          { role: "user", content: question.text },
        ];
        // The log (about 4,500 tokens) is over budget; the page read_evidence returns in this run
        // (about 3,000) is not.
        const budget: Budget = { compactAt: 4_000, leaveOutAt: noLimit };
        const compacting = yield* compactionHook({
          sources: sourcesOf(nodes, at.sessionId),
          budget,
          restore: () => Effect.succeed(null),
        });
        const runId = `${at.sessionId}:run`;
        const { invocations } = yield* scriptedRun({
          turns: [
            {
              toolCalls: [
                {
                  id: "new-1",
                  name: "read_evidence",
                  arguments: yield* stringifyJson({ id: result.id }),
                },
              ],
            },
            { text: "다시 읽었어요." },
          ],
          runId,
          threadId: at.sessionId,
          conversation: messages,
          tools: (yield* MemoryTools).runToolsFor({ ...at, runId, userNodeId: question.id }).tools,
          hooks: [compacting.hook],
        });
        const [first, second] = yield* invocations;
        const toolContent = (sent: ReadonlyArray<StoredMessage> | undefined, id: string) =>
          sent?.find((message) => message.role === "tool" && message.toolCallId === id)?.content;
        // Output answered before the latest answer is replaced by a pointer to its memory node.
        expect(toolContent(first?.history, "older-1")).toBe(clearedOutput(lintResult.id));
        // The latest answered run stays whole until a later run answers.
        expect(toolContent(first?.history, "old-1")).toBe(output);
        expect(first?.history.at(-1)).toEqual({ role: "user", content: "그 로그 다시 읽어 줘" });
        // The output of the call in progress reaches the model whole.
        expect(toolContent(second?.history, "old-1")).toBe(output);
        expect(toolContent(second?.history, "new-1")).toEqual(
          expect.stringContaining("빌드 로그 빌드 로그"),
        );
        // The conversation that is saved keeps every output.
        const saved = yield* (yield* RunStore).thread(at.sessionId);
        expect(toolContent(saved, "older-1")).toBe(lint);
        expect(toolContent(saved, "old-1")).toBe(output);
      }),
  );

  it.effect(
    "sends earlier turns as their summaries once clearing is not enough, if they still fit",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const nodes = yield* Nodes;
        const metadata = yield* metadataStore;
        const long = "배포 절차를 설명해요. ".repeat(50);
        const { userNodes, messages } = yield* conversation(nodes, at, [
          long,
          long,
          long,
          long,
          long,
        ]);
        const summaries = (blocks: readonly { end: number; text: string }[]) =>
          metadata.set(turnSummariesNamespace, at.sessionId, {
            blocks: blocks.map(({ end, text }) => ({
              end,
              nextTurnNodeId: userNodes[end]!.id,
              text,
            })),
          });
        const sent = (budget: Budget, conversation: ReadonlyArray<StoredMessage>) =>
          nextRequest(conversation, at.sessionId, budget);
        const overBudget: Budget = { compactAt: 1_000, leaveOutAt: noLimit };
        yield* summaries([{ end: 2, text: "- 배포 절차를 정했다" }]);
        const firstBlock = yield* sent(overBudget, messages);
        expect(firstBlock[0]).toEqual({
          role: "assistant",
          content: expect.stringContaining("user turns 1-2"),
        });
        expect(firstBlock[0]?.content).toContain("- 배포 절차를 정했다");
        expect(firstBlock[1]).toEqual({ role: "user", content: "질문 3" });
        expect(firstBlock.at(-1)).toEqual({ role: "user", content: "질문 6" });
        yield* summaries([
          { end: 2, text: "- 배포 절차를 정했다" },
          { end: 4, text: "- 배포 검증을 마쳤다" },
        ]);
        const twoBlocks = yield* sent(overBudget, messages);
        expect(twoBlocks[0]).toEqual(firstBlock[0]);
        expect(twoBlocks[1]?.content).toContain("user turns 3-4");
        expect(twoBlocks[2]).toEqual({ role: "user", content: "질문 5" });
        // Ready blocks already applied below the former 25% gate; removing that dead gate must not
        // resummarize or restore raw turns. The live request keeps the latest user message last.
        const lowUsage = budgetFor(200_000);
        expect(estimateConversation(messages)).toBeLessThan(200_000 * 0.25);
        expect(lowUsage.compactAt).toBe(0);
        expect(yield* sent(lowUsage, messages)).toEqual(twoBlocks);
        expect(twoBlocks.at(-1)).toEqual({ role: "user", content: "질문 6" });
        expect(yield* sent({ compactAt: noLimit, leaveOutAt: noLimit }, messages)).toEqual(
          twoBlocks,
        );
        // A conversation whose turn 3 is not the one summarized gets no summary.
        const other = messages.map((message) =>
          message.role === "user" && message.content === "질문 3"
            ? { ...message, content: "다른 질문" }
            : message,
        );
        expect((yield* sent(overBudget, other))[0]).toEqual({ role: "user", content: "질문 1" });
      }),
  );
});
