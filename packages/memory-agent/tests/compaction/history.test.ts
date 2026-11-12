import { DateTime, Duration, Effect, HashMap, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  budgetFor,
  clearedOutput,
  compactEffect,
  compactionHook,
  estimateConversation,
  type Budget,
} from "../../src/agent/compaction.ts";
import { type SessionSummary, SummaryEnd } from "../../src/chat-store/metadata.ts";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import type { JsonValue } from "../../src/json.ts";
import { RunStore } from "../../src/loop/store.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { MemoryTools } from "../../src/tools/memory.ts";
import { runTool } from "../../src/tools/run-tool.ts";
import type { ScriptedTurn } from "../../src/testing/scripted-model.ts";
import { scriptedRun } from "../support/loop-run.ts";
import { callTool } from "../support/run-tools.ts";
import { sqlRun } from "../support/sql.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { conversation, nextRequest, noLimit, sourcesOf } from "./fixtures.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Each test gets its own session in the shared agent, so nodes and metadata never leak. */
const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  return { projectId: project.id, sessionId: session.id };
});

const metadataStore = Effect.map(RunStore, (store) => store.chatMetadata);

testAgent()("compaction over recorded history", (it) => {
  it.effect(
    "tool result lookup keeps the first recorded node per call and omits calls without one",
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
        expect(
          HashMap.toEntries(yield* nodes.toolResultIds(at.sessionId, ["same-call", "missing"])),
        ).toEqual([["same-call", first.id]]);
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
        const tools = (yield* MemoryTools).toolsFor(at);
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

  it.effect(
    "read_tool_result opens a subagent's results from its parent and the parent's from it, not a stranger's",
    () =>
      Effect.gen(function* () {
        const parent = yield* freshSession;
        const other = yield* freshSession;
        const nodes = yield* Nodes;
        // A subagent's session under each conversation, as a delegated run makes it.
        const childOf = Effect.fnUntraced(function* (at: typeof parent, name: string) {
          yield* sqlRun(
            `INSERT INTO sessions (id, project_id, created_at, parent_session_id)
             VALUES (?, ?, 'now', ?)`,
            name,
            at.projectId,
            at.sessionId,
          );
          return { projectId: at.projectId, sessionId: name };
        });
        const child = yield* childOf(parent, `subagent-${parent.sessionId}-a`);
        const sibling = yield* childOf(parent, `subagent-${parent.sessionId}-b`);
        const stranger = yield* childOf(other, `subagent-${other.sessionId}`);
        const result = (at: typeof parent) =>
          nodes.append({ ...at, kind: "tool_result", text: `result of ${at.sessionId}` });
        const [parentResult, childResult, siblingResult, strangerResult] = yield* Effect.all([
          result(parent),
          result(child),
          result(sibling),
          result(stranger),
        ]);
        const memoryTools = yield* MemoryTools;
        const opens = (at: typeof parent, id: string) =>
          Effect.map(callTool(memoryTools.toolsFor(at), "read_tool_result", { id }), (page) =>
            Schema.is(Schema.Struct({ text: Schema.String }))(page),
          );
        expect(yield* opens(parent, childResult.id)).toBe(true);
        expect(yield* opens(child, parentResult.id)).toBe(true);
        expect(yield* opens(child, siblingResult.id)).toBe(true);
        expect(yield* opens(parent, strangerResult.id)).toBe(false);
        expect(yield* opens(child, strangerResult.id)).toBe(false);
        expect(yield* opens(stranger, childResult.id)).toBe(false);
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
        const budget: Budget = { compactAt: 4_000, leaveOutAt: noLimit, inputCeiling: noLimit };
        const compacting = yield* compactionHook({
          sources: sourcesOf(nodes, at.sessionId),
          budget,
          restore: () => Effect.succeed(null),
          promptCacheFor: Duration.hours(1),
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
          tools: (yield* MemoryTools).toolsFor(at),
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
    "a run leaves earlier messages out once the provider counts more than fits under the ceiling",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const readFile = runTool({
          name: "read_file",
          description: "Read a project file",
          parameters: Schema.Struct({ path: Schema.String }),
          handler: () => Effect.succeed({ content: "y".repeat(10_000) }),
        });
        // An earlier answer of about 4,000 tokens, then the question the run answers.
        const earlier = "x".repeat(16_000);
        const conversation: ReadonlyArray<StoredMessage> = [
          { role: "user", content: "설계를 설명해 줘" },
          { role: "assistant", content: earlier },
          { role: "user", content: "파일 읽어 줘" },
        ];
        const readCall: ScriptedTurn = {
          toolCalls: [{ id: "read-1", name: "read_file", arguments: '{"path":"a.ts"}' }],
        };
        /** The run's second request, after a first step that reads a file. */
        const secondRequest = Effect.fnUntraced(function* (name: string, first: ScriptedTurn) {
          const compacting = yield* compactionHook({
            sources: sourcesOf(yield* Nodes, at.sessionId),
            budget: { compactAt: 0, leaveOutAt: noLimit, inputCeiling: 14_000 },
            restore: () => Effect.succeed(null),
            promptCacheFor: Duration.hours(1),
          });
          const { invocations } = yield* scriptedRun({
            turns: [first, { text: "읽었어요." }],
            runId: `${at.sessionId}:${name}`,
            threadId: at.sessionId,
            conversation,
            tools: [readFile],
            hooks: [compacting.hook],
          });
          return (yield* invocations)[1]?.history ?? [];
        });

        // The provider counts about 8,000 tokens beyond the messages, which leaves about 6,000
        // under the ceiling; the second request's 6,600 do not fit, so the earlier answer goes.
        const counted = yield* secondRequest("counted", {
          ...readCall,
          usage: { inputTokens: { uncached: 12_000, total: 12_000 }, outputTokens: { total: 5 } },
        });
        expect(counted.some((message) => message.content === earlier)).toBe(false);
        expect(counted[0]?.content).toContain("earlier");
        expect(counted.at(-1)?.content).toContain("y".repeat(10_000));
        // Without a count the estimate alone decides, and the messages fit.
        const unreported = yield* secondRequest("unreported", readCall);
        expect(unreported.some((message) => message.content === earlier)).toBe(true);
      }),
  );

  it.effect("a run's first request fits under the ceiling by what the last request counted", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      // An earlier answer of about 4,000 tokens, then the question the run answers.
      const earlier = "x".repeat(16_000);
      const conversation: ReadonlyArray<StoredMessage> = [
        { role: "user", content: "설계를 설명해 줘" },
        { role: "assistant", content: earlier },
        { role: "user", content: "요약해 줘" },
      ];
      /** The run's first request, after a last request that counted `overhead` beyond it. */
      const firstRequest = Effect.fnUntraced(function* (
        name: string,
        overhead: Option.Option<number>,
      ) {
        const compacting = yield* compactionHook({
          sources: sourcesOf(yield* Nodes, at.sessionId),
          budget: { compactAt: 0, leaveOutAt: noLimit, inputCeiling: 14_000 },
          restore: () => Effect.succeed(null),
          promptCacheFor: Duration.hours(1),
          overhead,
        });
        const { invocations } = yield* scriptedRun({
          turns: [{ text: "요약했어요." }],
          runId: `${at.sessionId}:${name}`,
          threadId: at.sessionId,
          conversation,
          tools: [],
          hooks: [compacting.hook],
        });
        return (yield* invocations)[0]?.history ?? [];
      });

      // 12,000 tokens beyond the messages leave about 2,000 under the ceiling: the earlier answer goes.
      const counted = yield* firstRequest("counted", Option.some(12_000));
      expect(counted.some((message) => message.content === earlier)).toBe(false);
      expect(counted.at(-1)?.content).toBe("요약해 줘");
      const unknown = yield* firstRequest("unknown", Option.none());
      expect(unknown.some((message) => message.content === earlier)).toBe(true);
    }),
  );

  it.effect("sends the session's summary in place of the turns it covers, whatever the size", () =>
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
      const through = (turn: number, text: string): SessionSummary => ({
        text,
        end: SummaryEnd.cases.Turn.make({ turn, nodeId: userNodes[turn]!.id }),
      });
      const sent = (conversation: ReadonlyArray<StoredMessage>) =>
        nextRequest(conversation, at.sessionId, budgetFor(200_000));
      expect(estimateConversation(messages)).toBeLessThan(200_000 * 0.25);
      const first = through(2, "- 배포 절차를 정했다");
      expect(yield* metadata.replaceSummary(at.sessionId, Option.none(), first)).toBe(true);
      const summarized = yield* sent(messages);
      expect(summarized[0]).toEqual({
        role: "assistant",
        content: expect.stringContaining("Summary of the earlier conversation"),
      });
      expect(summarized[0]?.content).toContain("- 배포 절차를 정했다");
      expect(summarized[1]).toEqual({ role: "user", content: "질문 3" });
      expect(summarized.at(-1)).toEqual({ role: "user", content: "질문 6" });
      // The summary is rewritten as more is left out; a summary written meanwhile is kept.
      const second = through(4, "- 배포 절차를 정했다\n- 배포 검증을 마쳤다");
      expect(yield* metadata.replaceSummary(at.sessionId, Option.some(first), second)).toBe(true);
      expect(yield* metadata.replaceSummary(at.sessionId, Option.some(first), first)).toBe(false);
      const rewritten = yield* sent(messages);
      expect(rewritten[0]?.content).toContain("- 배포 검증을 마쳤다");
      expect(rewritten[1]).toEqual({ role: "user", content: "질문 5" });
      // A conversation whose turn 5 is not the one summarized gets no summary.
      const other = messages.map((message) =>
        message.role === "user" && message.content === "질문 5"
          ? { ...message, content: "다른 질문" }
          : message,
      );
      expect((yield* sent(other))[0]).toEqual({ role: "user", content: "질문 1" });
    }),
  );

  it.effect(
    "messages left out leave behind the user's words in them that a later message did not change",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const nodes = yield* Nodes;
        const said = (text: string) => nodes.append({ ...at, kind: "user", text });
        const kept = yield* said("테스트는 vitest로만 돌려 줘");
        const changed = yield* said("README는 영어로 써 줘");
        const correction = yield* said("아니, README는 한국어로 써 줘");
        const asked = yield* said("파일들을 읽어 줘");
        const answer = yield* nodes.append({ ...at, kind: "assistant", text: "알겠어요" });
        const linked = (from: string, to: string) =>
          sqlRun(
            "INSERT INTO edges VALUES (?, ?, 'corrects', 'llm', 0.95, ?)",
            from,
            to,
            DateTime.formatIso(DateTime.nowUnsafe()),
          );
        // Only a later message of the user changes what the user said.
        yield* linked(correction.id, changed.id);
        yield* linked(answer.id, kept.id);
        // Three answers of about 4,000 tokens each, then the question the run answers.
        const messages: ReadonlyArray<StoredMessage> = [
          ...[kept, changed, correction].flatMap((turn): ReadonlyArray<StoredMessage> => [
            { role: "user", content: turn.text },
            { role: "assistant", content: "x".repeat(16_000) },
          ]),
          { role: "user", content: asked.text },
        ];
        const leftOut = (summary: Option.Option<SessionSummary>, leaveOutAt: number) =>
          Effect.map(
            compactEffect({
              messages,
              state: { manual: { clearedThrough: 0, summarizedTurns: 0 }, summary },
              sources: {
                ...sourcesOf(nodes, at.sessionId),
                userMessages: nodes.userMessages(at.sessionId),
              },
              budget: { compactAt: 0, leaveOutAt, inputCeiling: noLimit },
            }),
            (compacted) => compacted.messages,
          );
        const correctionSent = { role: "user", content: correction.text };
        const askedSent = { role: "user", content: asked.text };
        // Everything before the latest user turns is left out; they are sent as they were said.
        const alone = yield* leftOut(Option.none(), 8_000);
        expect(alone.slice(1)).toEqual([correctionSent, askedSent]);
        // The summary of the first two turns stands in for them, and the rest is left out.
        const summarized = yield* leftOut(
          Option.some({
            text: "요약",
            end: SummaryEnd.cases.Turn.make({ turn: 2, nodeId: correction.id }),
          }),
          3_000,
        );
        expect(summarized[0]?.content).toContain("요약");
        expect(summarized.slice(2)).toEqual([correctionSent, askedSent]);
        [alone[0]?.content, summarized[1]?.content].forEach((note) => {
          expect(note).toContain(`(node ${kept.id}) ${kept.text}`);
          expect(note).not.toContain(changed.text);
          // The latest user turns are sent as they are, not listed.
          expect(note).not.toContain(correction.text);
          expect(note).not.toContain(asked.text);
        });
        expect(alone[0]?.content).toContain("left out to save context");
      }),
  );
});
