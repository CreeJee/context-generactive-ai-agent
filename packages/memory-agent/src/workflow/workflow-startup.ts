import { Context, Effect, Layer } from "effect";
import { WorkflowExecution } from "./execution.ts";
import { goalStateOf, standingOf } from "./goal-transitions.ts";
import { Workflows } from "./workflow.ts";

/**
 * The check every start runs before the owner engine resumes a workflow. It repairs sessions an
 * earlier version left in a Goal state no transition makes, stops the automatic runs of those and
 * of sessions whose Goal is not running, and settles new-Goal requests the restart left accepted.
 */
export class WorkflowStartup extends Context.Service<
  WorkflowStartup,
  { readonly repaired: number; readonly halted: number; readonly settled: number }
>()("memory-agent/workflow/workflow-startup/WorkflowStartup") {
  static readonly layer = Layer.effect(
    WorkflowStartup,
    Effect.gen(function* () {
      const workflows = yield* Workflows;
      const execution = yield* WorkflowExecution;
      const repaired = yield* workflows.checkAll();
      const pending = [
        ...(yield* execution.readySessions()),
        ...(yield* execution.retryingSessions()).map(({ sessionId }) => sessionId),
      ];
      const halted = yield* Effect.filter(pending, (sessionId) =>
        Effect.map(
          workflows.get(sessionId),
          (state) => goalStateOf(standingOf(state))._tag !== "Running",
        ),
      );
      yield* Effect.forEach([...new Set([...repaired, ...halted])], execution.stopReconciled, {
        discard: true,
      });
      const settled = yield* workflows.settleAbandonedNewGoalRequests();
      yield* Effect.annotateCurrentSpan({
        repaired: repaired.length,
        halted: halted.length,
        settled,
      });
      return WorkflowStartup.of({ repaired: repaired.length, halted: halted.length, settled });
    }).pipe(
      // A failed check leaves the sessions as an earlier version did; the app still starts.
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logError("Workflow startup check failed", cause),
          WorkflowStartup.of({ repaired: 0, halted: 0, settled: 0 }),
        ),
      ),
      Effect.withSpan("WorkflowStartup.check"),
    ),
  ).pipe(Layer.provide([Workflows.layer, WorkflowExecution.layer]));
}
