import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { OutcomeChecklist } from "./outcome-checklist";
import { chatCopy } from "./copy";

const copy = chatCopy.outcomeChecklist;

describe("OutcomeChecklist", () => {
  test("counts the met outcomes and says where each one stands", () => {
    const html = renderToStaticMarkup(
      <OutcomeChecklist
        outcomes={[
          { id: "O1", text: "Search returns results", status: { _tag: "Met", summary: "checked" } },
          { id: "O2", text: "Docs updated", status: { _tag: "InProgress", pending: ["c2", "c3"] } },
          { id: "O3", text: "No regressions", status: { _tag: "AwaitingCheck", stale: true } },
          { id: "O4", text: "Fast", status: { _tag: "Unplanned" } },
        ]}
      />,
    );
    expect(html).toContain(copy.heading(1, 4));
    expect(html).toContain(`${copy.status.Met} · checked`);
    expect(html).toContain(`${copy.status.InProgress} · ${copy.cardsLeft(2)}`);
    expect(html).toContain(`${copy.status.AwaitingCheck} · ${copy.recheckAfterChange}`);
    expect(html).toContain(copy.status.Unplanned);
  });
  test("shows nothing for a Goal without outcomes", () => {
    expect(renderToStaticMarkup(<OutcomeChecklist outcomes={[]} />)).toBe("");
  });
});
