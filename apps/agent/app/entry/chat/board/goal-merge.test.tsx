import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import type { GoalMergeState } from "../../api";
import { GoalMergeStatus, mergeFailed } from "./goal-merge";

const render = (node: ReactNode) =>
  renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>);
const state = (value: GoalMergeState) => value;

describe("GoalMergeStatus", () => {
  test("links a created pull request that has a web address", () => {
    const html = render(
      <GoalMergeStatus
        merge={state({ _tag: "PullRequestCreated", url: "https://example.com/pull/1" })}
      />,
    );
    expect(html).toContain('href="https://example.com/pull/1"');
    expect(html).toContain("PR을 만듦");
    expect(html).not.toContain("PR을 만듦: https");
  });

  test("shows an address that is not a web address as text, not a link", () => {
    const html = render(
      <GoalMergeStatus merge={state({ _tag: "PullRequestCreated", url: "example.com/pull/1" })} />,
    );
    expect(html).not.toContain("<a");
    expect(html).toContain("PR을 만듦: example.com/pull/1");
  });
});

describe("mergeFailed", () => {
  test("is true only for a merge a person has to move on from", () => {
    expect(mergeFailed(state({ _tag: "PullRequestFailed", stage: "push" }))).toBe(true);
    expect(mergeFailed(state({ _tag: "Merged", commit: "0123456789abcdef" }))).toBe(false);
    expect(mergeFailed(null)).toBe(false);
  });
});
