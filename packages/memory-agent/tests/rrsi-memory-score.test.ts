// Test fixture Promise boundary; production evaluation remains in the caller's Effect context.
import { Effect, Schema } from "effect";
import { it as effectTest } from "@effect/vitest";
import { expect, it } from "vite-plus/test";
import { Nodes } from "../src/memory/nodes.ts";
import {
  captureMemoryEvidence,
  evaluateMemoryAnswer,
  scoreMemoryAnswer,
} from "../src/rrsi/memory-score.ts";
import { corpus } from "../eval/rrsi-corpus.ts";
import { testRuntime } from "./support/runtime.ts";

// Deliberately malformed answer fixtures need a permissive JSON encoder.
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const setup = Effect.fnUntraced(function* () {
  const { runtime, project, session } = yield* Effect.promise(() => testRuntime());
  const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
  const scope = { projectId: project.id, sessionId: session.id };
  const previous = nodes.append({ ...scope, kind: "user", text: "obsolete-10" });
  const expected = {
    ...scope,
    text: "Correction: replace my previous decision with decision-10-violet.",
    decision: "decision-10-violet",
  };
  const correction = nodes.append({ ...scope, kind: "user", text: expected.text });
  const evidence = yield* captureMemoryEvidence(expected).pipe(Effect.provideService(Nodes, nodes));
  const answer = { decision: expected.decision, evidenceIds: [correction.id] };
  return { nodes, previous, correction, expected, evidence, answer };
});

effectTest.effect("captures the original correction before later turns and scores its JSON", () =>
  Effect.gen(function* () {
    const { nodes, evidence, answer, correction, previous } = yield* setup();
    const unrelated = nodes.append({
      projectId: evidence.projectId,
      sessionId: evidence.sessionId,
      kind: "user",
      text: "Read notes.txt.",
    });
    expect(evidence.id).toBe(correction.id);
    expect(
      yield* evaluateMemoryAnswer(yield* encodeJson(answer), evidence).pipe(
        Effect.provideService(Nodes, nodes),
      ),
    ).toBe(true);
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
      expect(
        yield* evaluateMemoryAnswer(yield* encodeJson(invalid), evidence).pipe(
          Effect.provideService(Nodes, nodes),
        ),
      ).toBe(false);
    }
  }),
);

effectTest.effect("rejects missing or mismatched original sources and incomplete captures", () =>
  Effect.gen(function* () {
    const { nodes, correction, evidence, expected, answer } = yield* setup();
    for (const source of [
      null,
      { ...correction, id: "other-node" },
      { ...correction, kind: "assistant" as const },
      { ...correction, projectId: "another-project" },
      { ...correction, sessionId: "another-session" },
      { ...correction, text: "obsolete-10" },
    ]) {
      const store = Nodes.of({ ...nodes, get: () => source });
      expect(
        yield* scoreMemoryAnswer(answer, evidence).pipe(Effect.provideService(Nodes, store)),
      ).toBe(false);
    }
    for (const source of [null, { ...correction, text: "obsolete-10" }]) {
      const store = Nodes.of({ ...nodes, latestOfKind: () => source });
      const error = yield* Effect.flip(
        captureMemoryEvidence(expected).pipe(Effect.provideService(Nodes, store)),
      );
      expect(error.reason).toBe("evaluation_incomplete");
    }
  }),
);

effectTest.effect("invalid output scores zero while native storage failures stay typed", () =>
  Effect.gen(function* () {
    const { nodes, evidence, expected, answer } = yield* setup();
    const unavailable = () => {
      throw new Error("private database details");
    };
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
