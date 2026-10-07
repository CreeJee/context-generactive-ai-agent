import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { Array as EffectArray } from "effect";
import { render } from "vitest-browser-react";
import { describe, expect } from "vite-plus/test";
import "../../app.css";
import { AccountModelPanel } from "./account-model-panel";
import { AccountSection, ModelSection, ProjectSection } from "./sidebar";

const alignedTerms = (root: HTMLElement, expected: string[]) => {
  const rows = [...root.querySelectorAll("dl > div")];
  expect(rows.map((row) => row.querySelector("dt")?.textContent)).toEqual(expected);
  for (const list of root.querySelectorAll("dl")) {
    expect(getComputedStyle(list).display).toBe("grid");
  }
  const valueEdges = rows.map((row) =>
    Math.round(row.querySelector("dd")!.getBoundingClientRect().left),
  );
  expect(EffectArray.dedupe(valueEdges).length).toBe(1);
};

describe("sidebar disclosures", () => {
  it.live("compatible reasoning output does not require an effort selector", () =>
    Effect.gen(function* () {
      const model = {
        provider: "openai-compatible" as const,
        id: "local-model",
        displayName: "Local model",
        isDefault: true,
        defaultReasoningEffort: "default",
        supportedReasoningEfforts: ["default"],
        capabilities: { inputModalities: ["text" as const], toolCalling: true, reasoning: true },
      };
      const props = {
        selection: {
          provider: "openai-compatible" as const,
          model: model.id,
          reasoningEffort: "default",
        },
        onSelect: () => {},
      };
      const screen = yield* sdkCall(() => render(<ModelSection {...props} models={[model]} />));
      yield* sdkCall(() =>
        expect.element(screen.getByRole("combobox", { name: "추론 강도" })).not.toBeInTheDocument(),
      );
      yield* sdkCall(() =>
        screen.rerender(
          <ModelSection
            {...props}
            models={[{ ...model, supportedReasoningEfforts: ["default", "low"] }]}
          />,
        ),
      );
      yield* sdkCall(() =>
        expect.element(screen.getByRole("combobox", { name: "추론 강도" })).toBeVisible(),
      );
    }),
  );
  it.live("account and model settings use the same data list columns", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <AccountModelPanel
              provider="openai"
              auth={{ provider: "openai", status: "signed-in" }}
              selection={{ provider: "openai", model: "model-1", reasoningEffort: "medium" }}
              modelName="Model 1"
            >
              <AccountSection
                provider="openai"
                auth={{ provider: "openai", status: "signed-in" }}
                onProviderChange={() => {}}
                onAction={() => {}}
              />
              <ModelSection
                models={[
                  {
                    provider: "openai",
                    id: "model-1",
                    displayName: "Model 1",
                    isDefault: true,
                    defaultReasoningEffort: "medium",
                    supportedReasoningEfforts: ["medium"],
                    capabilities: { inputModalities: ["text"], toolCalling: true, reasoning: true },
                  },
                ]}
                selection={{ provider: "openai", model: "model-1", reasoningEffort: "medium" }}
                onSelect={() => {}}
              />
            </AccountModelPanel>
          </div>,
        ),
      );

      yield* sdkCall(() => screen.getByRole("button", { name: /Model 1/ }).click());
      alignedTerms(screen.container, ["계정", "연결", "모델", "추론"]);
    }),
  );

  it.live("project settings retain aligned rows when expanded", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <ProjectSection
              projects={[
                {
                  id: "project-1",
                  root: "/tmp/project-1",
                  name: "Project 1",
                  crossRecallExcluded: false,
                  permissionMode: "ask",
                  createdAt: "2026-10-01T00:00:00.000Z",
                  hiddenAt: null,
                },
              ]}
              projectId="project-1"
              onSelect={() => {}}
              onAdd={() => Promise.resolve(null)}
              onPermissionMode={() => {}}
              onCrossRecall={() => {}}
              onHide={() => {}}
            />
          </div>,
        ),
      );

      yield* sdkCall(() => screen.getByRole("button", { name: /프로젝트 · Project 1/ }).click());
      alignedTerms(screen.container, ["프로젝트", "권한", "기억", "목록"]);
    }),
  );
});

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
