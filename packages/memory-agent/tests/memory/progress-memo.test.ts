import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import type { RunScope, StepRequest } from "../../src/loop/run.ts";
import { replayedToolCallIds } from "../../src/model/compatible.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { memoText, ProgressMemos } from "../../src/memory/progress-memo.ts";
import { summaryCharacters } from "../../src/agent/compaction-policy.ts";
import type { JsonValue } from "../../src/json.ts";
import { callTool } from "../support/run-tools.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";

const Updated = Schema.Struct({
  memo: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      text: Schema.String,
      evidence: Schema.Array(Schema.String),
    }),
  ),
});
const Refused = Schema.Struct({ error: Schema.String, problems: Schema.Array(Schema.String) });

/** A session with one recorded read, and update_memo for a run of it. */
const memoSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  const sessionId = yield* freshSession;
  const nodes = yield* Nodes;
  const at = { projectId: project.id, sessionId, runId: `${sessionId}:run` };
  // A call id another model wrote: a compatible request replays it under another id.
  const read = yield* nodes.append({
    ...at,
    kind: "tool_result",
    text: "export const retries = 3;",
    detail: { toolName: "read_file", toolCallId: "call_a|fc_b", ok: true },
  });
  const memos = yield* ProgressMemos;
  const tool = memos.toolFor(at);
  const update = (input: JsonValue) => callTool([tool], "update_memo", input);
  return { at, read, memos, update };
});

testAgent()("progress memo", (it) => {
  it.effect("an entry cites the node its evidence names, whichever id the model read", () =>
    Effect.gen(function* () {
      const { at, read, memos, update } = yield* memoSession;
      const renamed = replayedToolCallIds("call_a|fc_b")[0]!;
      expect(renamed).not.toBe("call_a|fc_b");
      const updated = yield* Schema.decodeUnknownEffect(Updated)(
        yield* update({
          add: [
            { kind: "found", text: "Retries are 3", evidence: ["call_a|fc_b"] },
            { kind: "found", text: "Read under its replayed id", evidence: [renamed] },
            { kind: "found", text: "Cited by node id", evidence: [read.id] },
            { kind: "open", text: "Is 3 enough?" },
          ],
        }),
      );
      expect(updated.memo.map(({ kind, text, evidence }) => ({ kind, text, evidence }))).toEqual([
        { kind: "found", text: "Retries are 3", evidence: [read.id] },
        { kind: "found", text: "Read under its replayed id", evidence: [read.id] },
        { kind: "found", text: "Cited by node id", evidence: [read.id] },
        { kind: "open", text: "Is 3 enough?", evidence: [] },
      ]);
      // Each entry is a note of the session, written by the run.
      const [first] = yield* memos.current(at.sessionId);
      expect(yield* (yield* Nodes).get(first!.id)).toMatchObject({
        kind: "note",
        sessionId: at.sessionId,
        runId: at.runId,
        detail: { memo: "found" },
      });
    }),
  );

  it.effect(
    "refuses the whole change when an entry lacks evidence or cites what is not there",
    () =>
      Effect.gen(function* () {
        const { at, memos, update } = yield* memoSession;
        const refused = yield* Schema.decodeUnknownEffect(Refused)(
          yield* update({
            add: [
              { kind: "open", text: "fine on its own" },
              { kind: "done", text: "Changed the config" },
              { kind: "found", text: "From a line", evidence: ["src/config.ts:12"] },
            ],
            remove: ["no-such-entry"],
          }),
        );
        expect(refused.error).toBe("memo_not_updated");
        expect(refused.problems).toEqual([
          "No entry no-such-entry in the memo.",
          '"Changed the config" needs evidence: only open entries go without.',
          "Evidence src/config.ts:12 is neither a tool call ID of this conversation nor a memory node ID of this project. For a file, cite the call that read it.",
        ]);
        expect(yield* memos.current(at.sessionId)).toEqual([]);
      }),
  );

  it.effect("a replaced or removed entry leaves the memo, and its note stays", () =>
    Effect.gen(function* () {
      const { at, read, memos, update } = yield* memoSession;
      yield* update({
        add: [
          { kind: "found", text: "Retries are 3", evidence: [read.id] },
          { kind: "open", text: "Is 3 enough?" },
        ],
      });
      const [retries, question] = yield* memos.current(at.sessionId);
      yield* update({
        replace: [
          { id: retries!.id, kind: "found", text: "Retries are 3, per call", evidence: [read.id] },
        ],
        remove: [question!.id],
      });
      const now = yield* memos.current(at.sessionId);
      expect(now.map(({ text }) => text)).toEqual(["Retries are 3, per call"]);
      const nodes = yield* Nodes;
      expect((yield* nodes.get(retries!.id))?.text).toBe("Retries are 3");
      expect(
        (yield* nodes.edgesOf(retries!.id)).filter((edge) => edge.kind === "supersedes"),
      ).toMatchObject([{ fromId: now[0]!.id, toId: retries!.id }]);
    }),
  );

  it.effect("refuses to grow past its limit until entries are replaced or removed", () =>
    Effect.gen(function* () {
      const { at, memos, update } = yield* memoSession;
      const long = "x".repeat(summaryCharacters - 10);
      yield* update({ add: [{ kind: "open", text: long }] });
      const refused = yield* Schema.decodeUnknownEffect(Refused)(
        yield* update({ add: [{ kind: "open", text: "one more question" }] }),
      );
      expect(refused.problems).toEqual([
        `The memo would hold ${summaryCharacters + 7} characters, over ${summaryCharacters}: replace or remove entries first.`,
      ]);
      const [entry] = yield* memos.current(at.sessionId);
      // Shrinking it is always allowed.
      yield* update({ replace: [{ id: entry!.id, kind: "open", text: "short now" }] });
      expect((yield* memos.current(at.sessionId)).map(({ text }) => text)).toEqual(["short now"]);
    }),
  );

  it.effect("the memo is shown at the end of every request, once it has an entry", () =>
    Effect.gen(function* () {
      const { at, memos, update } = yield* memoSession;
      const hook = memos.hookFor(at.sessionId);
      const request: StepRequest = {
        system: ["system"],
        history: [{ role: "user", content: "find the retry count" }],
        tools: [],
      };
      const scope: RunScope = {
        threadId: at.sessionId,
        runId: at.runId,
        emit: () => Effect.void,
        inBackground: Effect.ignore,
      };
      expect(yield* hook.request!(scope, request)).toEqual(request);
      yield* update({ add: [{ kind: "open", text: "Is 3 enough?" }] });
      const entries = yield* memos.current(at.sessionId);
      expect((yield* hook.request!(scope, request)).history).toEqual([
        ...request.history,
        { role: "user", content: memoText(entries) },
      ]);
    }),
  );
});
