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
  // A button may lead with its icon before the label.
  const match = html.match(new RegExp(`<button[^>]*>(?:<svg.*?</svg>)?\\s*${label}\\s*</button>`));
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
  test("titles the panel with its mode and stage", () => {
    expect(renderToStaticMarkup(<WorkflowArtifactPanel {...props} />)).toContain("Plan · 계획 중");
    expect(
      renderToStaticMarkup(
        <WorkflowArtifactPanel
          {...props}
          state={{ ...workflowFixture, phase: "running", mode: "goal" }}
        />,
      ),
    ).toContain("Goal · 실행 중");
    const done = renderToStaticMarkup(
      <WorkflowArtifactPanel {...props} state={{ ...workflowFixture, phase: "completed" }} />,
    );
    expect(done).toContain("Plan · 완료");
    // A completed Goal leaves nothing to approve, revise or pause; only the fold stays a button.
    for (const label of ["승인하고 실행", "Plan 수정", "일시 중지", "계속", "중단"])
      expect(done).not.toContain(label);
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
    expect(html).not.toContain("보드에서 이어서 실행");
    expect(html).toContain("Plan 수정");
  });
  test("uses server execute intent instead of inferring it from plan status", () => {
    // An executing artifact used to force the continue label. The server owns the decision.
    const html = renderToStaticMarkup(<WorkflowArtifactPanel {...props} />);
    expect(button(html, "승인하고 실행")).not.toContain(' disabled=""');
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
        "보드에서 이어서 실행",
      ),
    ).not.toContain(' disabled=""');
  });
  test("leaves a Goal mode Plan to its own approval", () => {
    const html = renderToStaticMarkup(
      <WorkflowArtifactPanel {...props} state={{ ...workflowFixture, mode: "goal" }} />,
    );
    expect(html).not.toContain("승인하고 실행");
    expect(html).toContain("Plan 수정");
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
    expect(button(html, "승인하고 실행")).toContain(' disabled=""');
    expect(html).toContain("Goal이 변경되어");
  });
  test("fails closed without an action snapshot and preserves local request guards", () => {
    expect(
      button(
        renderToStaticMarkup(<WorkflowArtifactPanel {...props} actions={null} />),
        "승인하고 실행",
      ),
    ).toContain(' disabled=""');
    expect(
      button(
        renderToStaticMarkup(<WorkflowArtifactPanel {...props} controlling />),
        "승인하고 실행",
      ),
    ).toContain(' disabled=""');
    expect(
      button(renderToStaticMarkup(<WorkflowArtifactPanel {...props} busy />), "승인하고 실행"),
    ).toContain(' disabled=""');
  });
  test("does not independently infer Goal control eligibility", () => {
    // The server allows resuming: the panel offers it, whatever the Goal's status says.
    const resumable = {
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
        actions={resumable}
      />,
    );
    expect(button(html, "계속")).not.toContain(' disabled=""');
    expect(button(html, "중단")).toContain(' disabled=""');
    // Neither pausing nor resuming allowed: pause shows, refused.
    const neither = {
      ...resumable,
      controls: {
        ...resumable.controls,
        resume: { allowed: false as const, reason: "goal_not_paused" as const },
      },
    };
    expect(
      button(
        renderToStaticMarkup(<WorkflowArtifactPanel {...props} actions={neither} />),
        "일시 중지",
      ),
    ).toContain(' disabled=""');
  });
});
