import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { WorkflowArtifactPanel, workflowModeLabel } from "./workflow-panel";
import { allowedWorkflowActions, workflowFixture } from "../session/workflow-test-fixtures";

const props = {
  state: workflowFixture,
  actions: allowedWorkflowActions,
  busy: false,
  disabled: false,
  controlling: false,
  onPause: () => {},
  onResume: () => {},
  onStop: () => {},
  onRevise: () => {},
  onExecute: () => {},
};
function button(html: string, label: string) {
  const match = html.match(new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`));
  if (!match) throw new Error(`Missing button: ${label}`);
  return match[0];
}

describe("server-authoritative workflow UI", () => {
  test("labels a passed, completed Verify workflow as finished, but not an active one", () => {
    const verified = {
      ...workflowFixture,
      phase: "verify" as const,
      goal: { ...workflowFixture.goal!, status: "completed" as const },
      plan: {
        ...workflowFixture.plan!,
        status: "completed" as const,
        verification: { ...workflowFixture.plan!.verification, status: "passed" as const },
      },
    };
    expect(workflowModeLabel(verified)).toBe("완료");
    expect(workflowModeLabel({ ...verified, phase: "completed" })).toBe("완료");
    expect(
      workflowModeLabel({ ...verified, plan: { ...verified.plan, status: "executing" } }),
    ).toBe("Verify");
    expect(
      workflowModeLabel({
        ...verified,
        plan: {
          ...verified.plan,
          verification: { ...verified.plan.verification, status: "failed" },
        },
      }),
    ).toBe("Verify");
    expect(workflowModeLabel({ ...verified, goal: { ...verified.goal, status: "active" } })).toBe(
      "Verify",
    );
    expect(workflowModeLabel({ ...verified, phase: "plan" })).toBe("Plan");
  });
  test("shows verification only while the plan is executing", () => {
    const state = { ...workflowFixture, phase: "verify" as const };
    const executing = renderToStaticMarkup(<WorkflowArtifactPanel {...props} state={state} />);
    expect(executing).toContain("Plan v4 · 검증 중");

    for (const [status, label] of [
      ["blocked", "막힘"],
      ["completed", "완료"],
      ["ready", "준비 완료"],
    ] as const) {
      const html = renderToStaticMarkup(
        <WorkflowArtifactPanel {...props} state={{ ...state, plan: { ...state.plan!, status } }} />,
      );
      expect(html).toContain(`Plan v4 · ${label}`);
      expect(html).not.toContain("Plan v4 · 검증 중");
    }
  });
  test("uses server execute intent instead of inferring it from plan status", () => {
    // An executing artifact used to force the continue label. The server owns the decision.
    const html = renderToStaticMarkup(<WorkflowArtifactPanel {...props} />);
    expect(button(html, "계획 실행")).not.toContain(' disabled=""');
    const actions = {
      ...allowedWorkflowActions,
      phases: {
        ...allowedWorkflowActions.phases,
        execute: { allowed: true as const, intent: "continue" as const },
      },
    };
    expect(
      button(
        renderToStaticMarkup(<WorkflowArtifactPanel {...props} actions={actions} />),
        "구현 계속",
      ),
    ).not.toContain(' disabled=""');
  });
  test("honors refusal even when the artifact looks executable", () => {
    const actions = {
      ...allowedWorkflowActions,
      phases: {
        ...allowedWorkflowActions.phases,
        execute: { allowed: false as const, reason: "plan_outdated" as const },
      },
    };
    const html = renderToStaticMarkup(<WorkflowArtifactPanel {...props} actions={actions} />);
    expect(button(html, "계획 실행")).toContain(' disabled=""');
    expect(html).toContain("Goal이 변경되어");
  });
  test("fails closed without an action snapshot and preserves local request guards", () => {
    expect(
      button(
        renderToStaticMarkup(<WorkflowArtifactPanel {...props} actions={null} />),
        "계획 실행",
      ),
    ).toContain(' disabled=""');
    expect(
      button(renderToStaticMarkup(<WorkflowArtifactPanel {...props} controlling />), "계획 실행"),
    ).toContain(' disabled=""');
    expect(
      button(renderToStaticMarkup(<WorkflowArtifactPanel {...props} busy />), "계획 실행"),
    ).toContain(' disabled=""');
  });
  test("does not independently infer Goal control eligibility", () => {
    const actions = {
      ...allowedWorkflowActions,
      controls: {
        pause: { allowed: false as const, reason: "goal_not_active" as const },
        resume: { allowed: true as const },
        stop: { allowed: false as const, reason: "goal_terminal" as const },
      },
    };
    const html = renderToStaticMarkup(
      <WorkflowArtifactPanel
        {...props}
        state={{ ...workflowFixture, phase: "goal" }}
        actions={actions}
      />,
    );
    expect(button(html, "계속")).not.toContain(' disabled=""');
    expect(button(html, "일시 중지")).toContain(' disabled=""');
    expect(button(html, "중단")).toContain(' disabled=""');
  });
});
