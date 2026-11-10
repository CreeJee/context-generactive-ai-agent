import { Effect } from "effect";
import { expect } from "vite-plus/test";
import type { PlanStep } from "../../src/workflow/contracts.ts";
import {
  OutcomeLedger,
  outcomeStandings,
  OutcomeStatus,
  servingCards,
  type OutcomeVerdict,
} from "../../src/workflow/outcome-ledger.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { freshSession, testAgent } from "../support/test-env.ts";

const card = (id: string, outcomes: readonly string[], status: PlanStep["status"]): PlanStep => ({
  id,
  title: `Card ${id}`,
  description: "",
  dependsOn: [],
  acceptanceCriteria: [`${id} works`],
  ruleRefs: [],
  outcomes,
  status,
  evidence: [],
});

const outcomes = [
  { id: "O1", text: "Notes are saved" },
  { id: "O2", text: "Notes are listed" },
  { id: "O3", text: "Notes are searchable" },
];

const verdict = (steps: readonly PlanStep[], outcomeId: string, met: boolean): OutcomeVerdict => ({
  outcomeId,
  outcomeText: outcomes.find((outcome) => outcome.id === outcomeId)!.text,
  met,
  summary: met ? "checked" : "missing",
  evidence: ["test run"],
  cards: servingCards({ steps, outcomeId }),
  goalHead: "abc123",
  runId: null,
  at: "2026-11-09T00:00:00.000Z",
});

testAgent()("OutcomeLedger", (it) => {
  it.effect("an outcome stands by its cards until a verdict holds for its text and card work", () =>
    Effect.sync(() => {
      const steps = [card("a", ["O1"], "done"), card("b", ["O1", "O2"], "done")];
      const judged = [verdict(steps, "O1", true), verdict(steps, "O2", false)];
      expect(outcomeStandings({ outcomes, steps, latest: judged })).toEqual([
        {
          outcomeId: "O1",
          outcomeText: "Notes are saved",
          status: OutcomeStatus.cases.Met.make({ summary: "checked" }),
        },
        {
          outcomeId: "O2",
          outcomeText: "Notes are listed",
          status: OutcomeStatus.cases.NotMet.make({ summary: "missing" }),
        },
        {
          outcomeId: "O3",
          outcomeText: "Notes are searchable",
          // No card names it and every card is done: it is judged on the whole Plan's work.
          status: OutcomeStatus.cases.AwaitingCheck.make({ stale: false }),
        },
      ]);
      expect(
        outcomeStandings({ outcomes, steps, latest: [...judged, verdict(steps, "O3", true)] })[2]
          ?.status,
      ).toEqual(OutcomeStatus.cases.Met.make({ summary: "checked" }));

      // A new card for O2 holds it in progress; once done, the old verdict judged other cards.
      const added = [...steps, card("c", ["O2"], "ready")];
      expect(outcomeStandings({ outcomes, steps: added, latest: judged })[1]?.status).toEqual(
        OutcomeStatus.cases.InProgress.make({ pending: ["c"] }),
      );
      // While a card is left, an outcome no card names waits for the planner to give it cards.
      expect(outcomeStandings({ outcomes, steps: added, latest: judged })[2]?.status).toEqual(
        OutcomeStatus.cases.Unplanned.make({}),
      );
      const finished = [...steps, card("c", ["O2"], "done")];
      expect(outcomeStandings({ outcomes, steps: finished, latest: judged })[1]?.status).toEqual(
        OutcomeStatus.cases.AwaitingCheck.make({ stale: true }),
      );

      // Reworded outcome text, or a card whose work changed, needs a new verdict.
      const reworded = [{ ...outcomes[0]!, text: "Notes are saved twice" }];
      expect(outcomeStandings({ outcomes: reworded, steps, latest: judged })[0]?.status).toEqual(
        OutcomeStatus.cases.AwaitingCheck.make({ stale: true }),
      );
      const rewritten = [{ ...steps[0]!, description: "Saved elsewhere" }, steps[1]!];
      expect(outcomeStandings({ outcomes, steps: rewritten, latest: judged })[0]?.status).toEqual(
        OutcomeStatus.cases.AwaitingCheck.make({ stale: true }),
      );
      // Serving another outcome as well is not a change of a card's work.
      const retagged = [{ ...steps[0]!, outcomes: ["O1", "O3"] }, steps[1]!];
      expect(outcomeStandings({ outcomes, steps: retagged, latest: judged })[0]?.status).toEqual(
        OutcomeStatus.cases.Met.make({ summary: "checked" }),
      );
    }),
  );

  it.effect("keeps every verdict and reads each outcome's latest", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(sessionId, {
        statement: "Keep notes",
        outcomes,
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      });
      const goalInstanceId = yield* workflows.goalInstanceId(sessionId);
      if (goalInstanceId === null) return yield* Effect.die("Expected Goal identity");
      const ledger = yield* OutcomeLedger;
      const steps = [card("a", ["O1"], "done"), card("b", ["O2"], "done")];

      yield* ledger.record(goalInstanceId, verdict(steps, "O1", false));
      yield* ledger.record(goalInstanceId, verdict(steps, "O2", true));
      yield* ledger.record(goalInstanceId, verdict(steps, "O1", true));

      expect(yield* ledger.latest(goalInstanceId)).toEqual([
        verdict(steps, "O1", true),
        verdict(steps, "O2", true),
      ]);
      expect(yield* ledger.latest("other-goal")).toEqual([]);
    }),
  );
});
