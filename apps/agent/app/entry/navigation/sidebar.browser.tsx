import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { Array as EffectArray } from "effect";
import { render } from "vitest-browser-react";
import { describe, expect } from "vite-plus/test";
import "../../app.css";
import { AccountModelPanel } from "./account-model-panel";
import { AccountManagerList } from "./account-profiles";
import { AccountSwitcherMenu } from "./account-switcher";
import { CompatibleAccountsList } from "./compatible-accounts";
import type { CompatibleAccountChange } from "./compatible-client";
import { ModelSection, ProjectSection } from "./sidebar";

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
  it.live("model settings use the same data list columns", () =>
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
      alignedTerms(screen.container, ["모델", "추론"]);
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

  it.live("the account manager lists every provider's accounts in one editable list", () =>
    Effect.gen(function* () {
      const actions: unknown[] = [];
      const observed = {
        status: "observed",
        windows: [{ name: "five_hour", usedPercent: 37, windowSeconds: 18_000, resetsAt: null }],
        observedAt: "2026-10-12T00:00:00.000Z",
      } as const;
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-96">
            <AccountManagerList
              providers={[
                {
                  provider: "openai",
                  auth: { provider: "openai", status: "signed-in" },
                  view: {
                    profiles: [
                      { id: "a", provider: "openai", label: "개인", selected: true, createdAt: 1 },
                    ],
                    login: { status: "idle" },
                  },
                  quota: {
                    provider: "openai",
                    checkedAt: "2026-10-12T00:00:00.000Z",
                    accounts: [
                      {
                        accountId: "a",
                        label: "개인",
                        selected: true,
                        quota: { status: "unavailable", reason: "credential_expired" },
                      },
                    ],
                  },
                  quotaFailed: false,
                  busy: false,
                },
                {
                  provider: "anthropic",
                  auth: { provider: "anthropic", status: "signed-in" },
                  view: {
                    profiles: [
                      {
                        id: "c",
                        provider: "anthropic",
                        label: "회사",
                        selected: true,
                        createdAt: 2,
                      },
                    ],
                    login: { status: "idle" },
                  },
                  quota: {
                    provider: "anthropic",
                    checkedAt: "2026-10-12T00:00:00.000Z",
                    accounts: [{ accountId: "c", label: "회사", selected: true, quota: observed }],
                  },
                  quotaFailed: false,
                  busy: false,
                },
              ]}
              activeProvider="openai"
              error={null}
              onAction={(provider, action) => actions.push({ provider, action })}
            />
          </div>,
        ),
      );

      const personal = screen.getByRole("listitem", { name: "개인 (ChatGPT)" });
      yield* sdkCall(() => expect.element(personal.getByText("사용 중")).toBeVisible());
      yield* sdkCall(() =>
        expect
          .element(
            personal.getByText("구독 한도 조회 불가: 저장된 로그인이 만료돼 조회하지 않았어요"),
          )
          .toBeVisible(),
      );
      // Only the provider in use has an account in use, though each provider keeps a selection.
      const work = screen.getByRole("listitem", { name: "회사 (Claude)" });
      yield* sdkCall(() => expect.element(work.getByText("사용 중")).not.toBeInTheDocument());
      yield* sdkCall(() =>
        expect
          .element(work.getByRole("meter", { name: "5시간" }))
          .toHaveAttribute("aria-valuenow", "37"),
      );
      yield* sdkCall(() => work.getByRole("button", { name: "회사 이름 변경" }).click());
      yield* sdkCall(() => work.getByRole("textbox", { name: "계정 이름" }).fill("팀"));
      yield* sdkCall(() => work.getByRole("button", { name: "이름 저장" }).click());

      yield* sdkCall(() => screen.getByRole("button", { name: "ChatGPT 계정 추가" }).click());
      yield* sdkCall(() => screen.getByRole("textbox", { name: "새 계정 이름" }).fill("부계정"));
      yield* sdkCall(() => screen.getByRole("button", { name: "로그인" }).click());
      expect(actions).toEqual([
        { provider: "anthropic", action: { intent: "rename", accountId: "c", label: "팀" } },
        { provider: "openai", action: { intent: "add", label: "부계정" } },
      ]);
    }),
  );

  it.live(
    "the account switcher lists every provider's accounts and switches across providers",
    () =>
      Effect.gen(function* () {
        const switched: unknown[] = [];
        let managed = 0;
        const screen = yield* sdkCall(() =>
          render(
            <div className="w-72">
              <AccountSwitcherMenu
                entries={[
                  {
                    kind: "profile",
                    provider: "openai",
                    profile: {
                      id: "a",
                      provider: "openai",
                      label: "개인",
                      selected: true,
                      createdAt: 1,
                    },
                    quota: { status: "unavailable", reason: "lookup_failed" },
                    current: true,
                  },
                  {
                    kind: "profile",
                    provider: "anthropic",
                    profile: {
                      id: "c",
                      provider: "anthropic",
                      label: "회사",
                      selected: true,
                      createdAt: 2,
                    },
                    quota: {
                      status: "observed",
                      windows: [
                        {
                          name: "five_hour",
                          usedPercent: 37,
                          windowSeconds: 18_000,
                          resetsAt: null,
                        },
                      ],
                      observedAt: "2026-10-12T00:00:00.000Z",
                    },
                    current: false,
                  },
                  {
                    kind: "compatible",
                    account: {
                      id: "e",
                      label: "로컬 서버",
                      baseUrl: "http://localhost:1234/v1",
                      models: [],
                      hasApiKey: false,
                      selected: true,
                    },
                    current: false,
                  },
                ]}
                busy={false}
                error={null}
                onSwitch={(target) => switched.push(target)}
                onManage={() => void (managed += 1)}
              />
            </div>,
          ),
        );

        yield* sdkCall(() =>
          screen.getByRole("button", { name: "계정 전환: 개인 (ChatGPT)" }).click(),
        );
        const work = screen.getByRole("menuitem", { name: "회사 (Claude)" });
        yield* sdkCall(() => expect.element(work.getByText("37%")).toBeVisible());
        yield* sdkCall(() =>
          expect
            .element(
              screen
                .getByRole("menuitem", { name: "로컬 서버 (OpenAI 호환)" })
                .getByText("모델 없음"),
            )
            .toBeVisible(),
        );
        yield* sdkCall(() => work.click());
        expect(switched).toEqual([{ provider: "anthropic", accountId: "c" }]);
        yield* sdkCall(() => screen.getByRole("button", { name: "계정 관리" }).click());
        expect(managed).toBe(1);
      }),
  );

  it.live("compatible endpoints are added like accounts and get models registered under them", () =>
    Effect.gen(function* () {
      const changes: CompatibleAccountChange[] = [];
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-96">
            <CompatibleAccountsList
              accounts={[
                {
                  id: "e",
                  label: "로컬 서버",
                  baseUrl: "http://localhost:1234/v1",
                  models: [],
                  hasApiKey: false,
                  selected: true,
                },
              ]}
              activeProvider="openai-compatible"
              busy={false}
              failed={false}
              handlers={{
                onChange: (change) => Promise.resolve(void changes.push(change)),
                onTest: () => Promise.resolve(),
                onDiscover: () => Promise.resolve(["served-model"]),
              }}
            />
          </div>,
        ),
      );
      const endpoint = screen.getByRole("listitem", { name: "로컬 서버 (OpenAI 호환)" });
      yield* sdkCall(() => expect.element(endpoint.getByText("사용 중")).toBeVisible());
      yield* sdkCall(() => endpoint.getByRole("button", { name: "서버 모델 불러오기" }).click());
      yield* sdkCall(() => endpoint.getByRole("button", { name: "served-model" }).click());
      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 저장" }).click());

      yield* sdkCall(() =>
        screen.getByRole("button", { name: "OpenAI 호환 엔드포인트 추가" }).click(),
      );
      yield* sdkCall(() =>
        screen.getByRole("textbox", { name: "Base URL" }).fill("https://api.example.com/v1"),
      );
      yield* sdkCall(() => screen.getByRole("button", { name: "추가" }).click());
      expect(changes).toEqual([
        {
          intent: "save-model",
          accountId: "e",
          model: {
            id: "served-model",
            contextWindow: 32768,
            outputBudget: 4096,
            toolCalling: true,
          },
        },
        { intent: "create", baseUrl: "https://api.example.com/v1" },
      ]);
    }),
  );
});

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
