import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { Array as EffectArray } from "effect";
import { render } from "vitest-browser-react";
import { describe, expect } from "vite-plus/test";
import "../../app.css";
import { AccountModelPanel } from "./account-model-panel";
import { AccountProfiles } from "./account-profiles";
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

      const trigger = screen.getByRole("button", { name: "프로젝트 Project 1" });
      expect(trigger.element().textContent).toBe("Project 1");
      yield* sdkCall(() => trigger.click());
      alignedTerms(screen.container, ["프로젝트", "권한", "기억", "목록"]);
    }),
  );

  it.live("expanded accounts show each account's quota status and switch accounts", () =>
    Effect.gen(function* () {
      const actions: unknown[] = [];
      const unavailable = { status: "unavailable", reason: "no_permitted_route" } as const;
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <AccountProfiles
              view={{
                profiles: [
                  { id: "a", provider: "openai", label: "개인", selected: true, createdAt: 1 },
                  { id: "b", provider: "openai", label: "회사", selected: false, createdAt: 2 },
                ],
                login: { status: "idle" },
              }}
              quota={{
                provider: "openai",
                checkedAt: "2026-10-12T00:00:00.000Z",
                accounts: [
                  { accountId: "a", label: "개인", selected: true, quota: unavailable },
                  { accountId: "b", label: "회사", selected: false, quota: unavailable },
                ],
              }}
              quotaFailed={false}
              error={null}
              busy={false}
              onAction={(action) => actions.push(action)}
            />
          </div>,
        ),
      );

      const personal = screen.getByRole("listitem", { name: "개인" });
      yield* sdkCall(() => expect.element(personal.getByText("사용 중")).toBeVisible());
      yield* sdkCall(() =>
        expect
          .element(personal.getByText("구독 한도 조회 불가: 허용된 조회 경로가 확인되지 않았어요"))
          .toBeVisible(),
      );
      yield* sdkCall(() =>
        screen
          .getByRole("listitem", { name: "회사" })
          .getByRole("button", { name: "전환" })
          .click(),
      );
      expect(actions).toEqual([{ intent: "select", accountId: "b" }]);
    }),
  );
});

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
