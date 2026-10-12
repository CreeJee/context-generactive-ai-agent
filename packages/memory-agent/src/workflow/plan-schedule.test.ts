import { describe, expect, it } from "@effect/vitest";
import { planDependencyIssues, planSchedule } from "./plan-schedule.ts";
import type { PlanStep } from "./workflow.ts";

const step = (
  id: string,
  dependsOn: readonly string[] = [],
  status: PlanStep["status"] = "pending",
): PlanStep => ({
  id,
  title: id,
  description: id,
  dependsOn,
  acceptanceCriteria: [],
  ruleRefs: [],
  status,
  evidence: [],
});

describe("planDependencyIssues", () => {
  it("reports unknown, self and cyclic dependencies", () => {
    expect(
      planDependencyIssues([
        step("a", ["c"]),
        step("b", ["a", "b", "missing"]),
        step("c", ["b"]),
        step("d", ["a"]),
      ]),
    ).toEqual([
      { _tag: "SelfDependency", stepId: "b" },
      { _tag: "UnknownDependency", stepId: "b", dependsOn: "missing" },
      { _tag: "DependencyCycle", cycle: ["a", "c", "b", "a"] },
    ]);
  });

  it("accepts an acyclic Plan", () => {
    expect(planDependencyIssues([step("a"), step("b", ["a"]), step("c", ["a", "b"])])).toEqual([]);
  });
});

describe("planSchedule", () => {
  it("makes pending steps ready only once every dependency is completed", () => {
    expect(
      planSchedule([
        step("a", [], "completed"),
        step("b", ["a"]),
        step("c", ["a", "b"]),
        step("d", [], "in_progress"),
      ]),
    ).toEqual({
      kind: "runnable",
      ready: ["b"],
      inProgress: ["d"],
      waiting: [{ stepId: "c", unmet: [{ id: "b", status: "pending" }] }],
    });
  });

  it("keeps independent steps runnable beside a blocked step", () => {
    expect(planSchedule([step("a", [], "blocked"), step("b", ["a"]), step("c")])).toMatchObject({
      kind: "runnable",
      ready: ["c"],
      waiting: [{ stepId: "b", unmet: [{ id: "a", status: "blocked" }] }],
    });
  });

  it("stalls when every remaining step is blocked or waits on one", () => {
    expect(planSchedule([step("a", [], "blocked"), step("b", ["a"]), step("c", ["b"])])).toEqual({
      kind: "stalled",
      blocked: ["a"],
      waiting: [
        { stepId: "b", unmet: [{ id: "a", status: "blocked" }] },
        { stepId: "c", unmet: [{ id: "b", status: "pending" }] },
      ],
    });
  });

  it("reads Plans saved before validation without breaking", () => {
    // Unknown and self dependencies carry no ordering; a saved cycle never becomes ready.
    expect(planSchedule([step("a", ["missing", "a"]), step("b", ["c"]), step("c", ["b"])])).toEqual(
      {
        kind: "runnable",
        ready: ["a"],
        inProgress: [],
        waiting: [
          { stepId: "b", unmet: [{ id: "c", status: "pending" }] },
          { stepId: "c", unmet: [{ id: "b", status: "pending" }] },
        ],
      },
    );
    expect(planSchedule([step("a", [], "completed")])).toEqual({ kind: "finished" });
  });
});
