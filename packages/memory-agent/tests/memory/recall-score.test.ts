import { Effect, Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { Nodes, NodeStoreFailed } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import {
  captureMemoryEvidence,
  evaluateMemoryAnswer,
  scoreMemoryAnswer,
} from "../../src/rrsi/memory-score.ts";
import { corpus } from "../../eval/rrsi-corpus.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

// Deliberately malformed answer fixtures need a permissive JSON encoder.
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** A fresh session whose latest user turn corrects an earlier decision, captured as evidence. */
const corrected = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  const nodes = yield* Nodes;
  const scope = { projectId: project.id, sessionId: session.id };
  const previous = yield* nodes.append({ ...scope, kind: "user", text: "obsolete-10" });
  const expected = {
    ...scope,
    text: "Correction: replace my previous decision with decision-10-violet.",
    decision: "decision-10-violet",
  };
  const correction = yield* nodes.append({ ...scope, kind: "user", text: expected.text });
  const evidence = yield* captureMemoryEvidence(expected);
  const answer = { decision: expected.decision, evidenceIds: [correction.id] };
  return { nodes, previous, correction, expected, evidence, answer };
});

testAgent()("RRSI memory score", (it) => {
  it.effect("captures the original correction before later turns and scores its JSON", () =>
    Effect.gen(function* () {
      const { nodes, evidence, answer, correction, previous } = yield* corrected;
      const unrelated = yield* nodes.append({
        projectId: evidence.projectId,
        sessionId: evidence.sessionId,
        kind: "user",
        text: "Read notes.txt.",
      });
      expect(evidence.id).toBe(correction.id);
      expect(yield* evaluateMemoryAnswer(yield* encodeJson(answer), evidence)).toBe(true);
      for (const invalid of [
        { ...answer, decision: `not ${evidence.decision}` },
        { ...answer, decision: "obsolete-10" },
        { ...answer, evidenceIds: ["11111111-1111-1111-1111-111111111111"] },
        { ...answer, evidenceIds: [previous.id] },
        { ...answer, evidenceIds: [unrelated.id] },
        { ...answer, evidenceIds: [] },
        { ...answer, evidenceIds: [correction.id, unrelated.id] },
        { ...answer, evidenceIds: [correction.id, correction.id] },
      ]) {
        expect(yield* evaluateMemoryAnswer(yield* encodeJson(invalid), evidence)).toBe(false);
      }
    }),
  );

  it.effect("rejects missing or mismatched original sources and incomplete captures", () =>
    Effect.gen(function* () {
      const { nodes, correction, evidence, expected, answer } = yield* corrected;
      for (const source of [
        null,
        { ...correction, id: "other-node" },
        { ...correction, kind: "assistant" as const },
        { ...correction, projectId: "another-project" },
        { ...correction, sessionId: "another-session" },
        { ...correction, text: "obsolete-10" },
      ]) {
        const store = Nodes.of({ ...nodes, get: () => Effect.succeed(source) });
        expect(
          yield* scoreMemoryAnswer(answer, evidence).pipe(Effect.provideService(Nodes, store)),
        ).toBe(false);
      }
      for (const source of [null, { ...correction, text: "obsolete-10" }]) {
        const store = Nodes.of({ ...nodes, latestOfKind: () => Effect.succeed(source) });
        const error = yield* Effect.flip(
          captureMemoryEvidence(expected).pipe(Effect.provideService(Nodes, store)),
        );
        expect(error.reason).toBe("evaluation_incomplete");
      }
    }),
  );

  it.effect("invalid output scores zero while native storage failures stay typed", () =>
    Effect.gen(function* () {
      const { nodes, evidence, expected, answer } = yield* corrected;
      const unavailable = () =>
        Effect.fail(NodeStoreFailed.make({ cause: new Error("private database details") }));
      const store = Nodes.of({ ...nodes, get: unavailable, latestOfKind: unavailable });
      for (const text of [
        `My decision is not ${evidence.decision}. ${evidence.id}`,
        `\`\`\`json\n${yield* encodeJson(answer)}\n\`\`\``,
        yield* encodeJson({ ...answer, explanation: "The decision is obsolete-10." }),
        yield* encodeJson({ decision: evidence.decision, evidenceIds: evidence.id }),
        yield* encodeJson({ evidenceIds: [evidence.id] }),
      ]) {
        expect(
          yield* evaluateMemoryAnswer(text, evidence).pipe(Effect.provideService(Nodes, store)),
        ).toBe(false);
      }
      const readError = yield* Effect.flip(
        evaluateMemoryAnswer(yield* encodeJson(answer), evidence).pipe(
          Effect.provideService(Nodes, store),
        ),
      );
      const captureError = yield* Effect.flip(
        captureMemoryEvidence(expected).pipe(Effect.provideService(Nodes, store)),
      );
      expect(readError.reason).toBe("trial_execution_failed");
      expect(captureError.reason).toBe("trial_execution_failed");
      expect(readError.message).not.toContain("private database details");
    }),
  );
});

it("identifies the correction independently of the final answer in every split", () => {
  for (const split of ["evolve", "validation", "sealed"] as const) {
    for (const task of corpus(split)) {
      switch (task.domain) {
        case "coding":
          break;
        case "memory":
          expect(task.turns[task.correctionTurnIndex]).toBe(
            `Correction: replace my previous decision with ${task.expected}.`,
          );
          expect(task.correctionTurnIndex).toBeLessThan(task.turns.length - 1);
          break;
      }
    }
  }
});
