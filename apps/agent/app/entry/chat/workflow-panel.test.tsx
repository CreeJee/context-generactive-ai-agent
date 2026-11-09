import { isTruthy } from "../../truthy.ts";
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
  kanbanRunning: false,
};
function button(html: string, label: string) {
  const match = html.match(new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`));
  if (!isTruthy(match)) throw new Error(`Missing button: ${label}`);
  return match[0];
}

describe("server-authoritative workflow UI", () => {
  test("labels a completed workflow as done and any other by its mode", () => {
    expect(workflowModeLabel({ ...workflowFixture, phase: "completed" })).toBe("완료");
    expect(workflowModeLabel({ ...workflowFixture, phase: "running", mode: "goal" })).toBe("Goal");
    expect(workflowModeLabel(workflowFixture)).toBe("Plan");
    expect(workflowModeLabel({ ...workflowFixture, phase: "chat", mode: "goal" })).toBe("Chat");
  });
  test("leaves the Plan to a running board's loop instead of offering to continue it", () => {
    const actions = {
      ...allowedWorkflowActions,
      moves: {
        ...allowedWorkflowActions.moves,
        run: { allowed: true as const, intent: "continue" as const },
      },
    };
    const html = renderToStaticMarkup(
      <WorkflowArtifactPanel {...props} actions={actions} kanbanRunning />,
    );
    expect(html).not.toContain("구현 계속");
    expect(html).toContain("수정 요청");
  });
  test("uses server execute intent instead of inferring it from plan status", () => {
    // An executing artifact used to force the continue label. The server owns the decision.
    const html = renderToStaticMarkup(<WorkflowArtifactPanel {...props} />);
    expect(button(html, "계획 실행")).not.toContain(' disabled=""');
    const actions = {
      ...allowedWorkflowActions,
      moves: {
        ...allowedWorkflowActions.moves,
        run: { allowed: true as const, intent: "continue" as const },
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
      moves: {
        ...allowedWorkflowActions.moves,
        run: { allowed: false as const, reason: "plan_outdated" as const },
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
        state={{ ...workflowFixture, mode: "goal" }}
        actions={actions}
      />,
    );
    expect(button(html, "계속")).not.toContain(' disabled=""');
    expect(button(html, "일시 중지")).toContain(' disabled=""');
    expect(button(html, "중단")).toContain(' disabled=""');
  });
});
