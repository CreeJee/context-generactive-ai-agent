import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { AccountModelPanel } from "./account-model-panel";
import { ProjectSection } from "./sidebar";

describe("sidebar disclosure", () => {
  test("project section puts the same downward chevron after its label", () => {
    const html = renderToStaticMarkup(
      <ProjectSection
        projects={[]}
        projectId={null}
        onSelect={() => {}}
        onAdd={async () => null}
        onPermissionMode={() => {}}
        onCrossRecall={() => {}}
        onHide={() => {}}
      />,
    );
    const trigger = html.split("</button>")[0] ?? "";
    expect(trigger).toContain("min-h-10");
    expect(trigger.indexOf("프로젝트")).toBeLessThan(trigger.indexOf("lucide-chevron-down"));
    expect(trigger).toContain("group-data-[panel-open]:rotate-180");
  });

  test("account and project headers use the same disclosure trigger styling", () => {
    const account = renderToStaticMarkup(
      <AccountModelPanel
        provider="openai"
        auth={{ provider: "openai", status: "signed-out" }}
        selection={null}
      >
        Settings
      </AccountModelPanel>,
    );
    const project = renderToStaticMarkup(
      <ProjectSection
        projects={[]}
        projectId={null}
        onSelect={() => {}}
        onAdd={async () => null}
        onPermissionMode={() => {}}
        onCrossRecall={() => {}}
        onHide={() => {}}
      />,
    );
    for (const markup of [account, project]) {
      const trigger = markup.split("</button>")[0] ?? "";
      expect(trigger).toContain("min-h-10");
      expect(trigger).toContain("px-3");
      expect(trigger).toContain("lucide-chevron-down");
      expect(trigger).toContain("group-data-[panel-open]:rotate-180");
    }
  });
});
