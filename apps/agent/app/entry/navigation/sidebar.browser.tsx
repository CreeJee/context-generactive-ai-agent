import { it } from "@effect/vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Cause, Effect, Schema } from "effect";
import type { ReactNode } from "react";
import { useState } from "react";
import { Array as EffectArray } from "effect";
import { createMemoryRouter, RouterProvider } from "react-router";
import { render } from "vitest-browser-react";
import { describe, expect, beforeEach } from "vite-plus/test";
import "../../app.css";
import { AccountLoginState, ProviderAuthState } from "../api";
import type { Session } from "../api";
import { AccountManagerList, QuotaStatus } from "./account-profiles";
import { AccountEntry, AccountSwitcherMenu } from "./account-switcher";
import { CompatibleAccountsList } from "./compatible-accounts";
import type { CompatibleAccountChange } from "./compatible-client";
import { ModelSection, SessionSection } from "./sidebar";
import type { ProjectWorking } from "../queries/project";
import { SidebarProvider } from "../../components/ui/sidebar";

/** The folds as the sidebar stored them; a missing or malformed value fails the read. */
const storedFolds = () =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    localStorage.getItem("context-agent-session-groups-open-v1"),
  );

/** Renders under the app's Lingui instance, which the test setup activates in Korean. */
const withI18n = {
  wrapper: ({ children }: { children: ReactNode }) => (
    <I18nProvider i18n={i18n}>{children}</I18nProvider>
  ),
};

/**
 * SessionSection draws SidebarMenuButtons, which need the sidebar context, and conversation rows,
 * which are react-router Links, so the section renders under the app's router like the page does.
 */
const withSidebar = {
  wrapper: ({ children }: { children: ReactNode }) => {
    const [router] = useState(() => createMemoryRouter([{ path: "*", element: children }]));
    return (
      <I18nProvider i18n={i18n}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </I18nProvider>
    );
  },
};

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
  // The project groups' folds persist in the browser's storage; every test starts like a first visit.
  beforeEach(() => localStorage.removeItem("context-agent-session-groups-open-v1"));

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
          account: "endpoint",
          model: model.id,
          reasoningEffort: "default",
        },
        onSelect: () => {},
      };
      const screen = yield* sdkCall(() =>
        render(<ModelSection {...props} models={[model]} />, withI18n),
      );
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
          </div>,
          withI18n,
        ),
      );

      alignedTerms(screen.container, ["모델", "추론"]);
    }),
  );

  it.live("the account manager lists every provider's accounts in one editable list", () =>
    Effect.gen(function* () {
      const actions: unknown[] = [];
      const observed = QuotaStatus.observed({
        windows: [{ name: "five_hour", usedPercent: 37, windowSeconds: 18_000, resetsAt: null }],
        observedAt: "2026-10-12T00:00:00.000Z",
      });
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-96">
            <AccountManagerList
              providers={[
                {
                  provider: "openai",
                  auth: ProviderAuthState["signed-in"]({ provider: "openai" }),
                  view: {
                    _tag: "subscription",
                    profiles: [
                      { id: "a", provider: "openai", label: "개인", selected: true, createdAt: 1 },
                    ],
                    login: AccountLoginState.idle(),
                  },
                  quota: {
                    provider: "openai",
                    checkedAt: "2026-10-12T00:00:00.000Z",
                    accounts: [
                      {
                        accountId: "a",
                        label: "개인",
                        selected: true,
                        quota: QuotaStatus.unavailable({ reason: "credential_expired" }),
                      },
                    ],
                  },
                  quotaFailed: false,
                  busy: false,
                },
                {
                  provider: "anthropic",
                  auth: ProviderAuthState["signed-in"]({ provider: "anthropic" }),
                  view: {
                    _tag: "subscription",
                    profiles: [
                      {
                        id: "c",
                        provider: "anthropic",
                        label: "회사",
                        selected: true,
                        createdAt: 2,
                      },
                    ],
                    login: AccountLoginState.idle(),
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
          withI18n,
        ),
      );

      const personal = screen.getByRole("listitem", { name: "개인 (ChatGPT)" });
      yield* sdkCall(() => expect.element(personal.getByText("사용 중")).toBeVisible());
      yield* sdkCall(() =>
        expect
          .element(
            personal.getByText("구독 한도 조회 불가: 저장된 로그인이 만료돼 조회하지 않았습니다"),
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
                  AccountEntry.profile({
                    provider: "openai",
                    profile: {
                      id: "a",
                      provider: "openai",
                      label: "개인",
                      selected: true,
                      createdAt: 1,
                    },
                    quota: QuotaStatus.unavailable({ reason: "lookup_failed" }),
                    current: true,
                  }),
                  AccountEntry.profile({
                    provider: "anthropic",
                    profile: {
                      id: "c",
                      provider: "anthropic",
                      label: "회사",
                      selected: true,
                      createdAt: 2,
                    },
                    quota: QuotaStatus.observed({
                      windows: [
                        {
                          name: "five_hour",
                          usedPercent: 37,
                          windowSeconds: 18_000,
                          resetsAt: null,
                        },
                      ],
                      observedAt: "2026-10-12T00:00:00.000Z",
                    }),
                    current: false,
                  }),
                  AccountEntry.compatible({
                    account: {
                      id: "e",
                      label: "로컬 서버",
                      baseUrl: "http://localhost:1234/v1",
                      models: [],
                      hasApiKey: false,
                      selected: true,
                    },
                    current: false,
                  }),
                ]}
                busy={false}
                error={null}
                onSwitch={(target) => switched.push(target)}
                onManage={() => void (managed += 1)}
              />
            </div>,
            withI18n,
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
                .getByRole("menuitem", {
                  name: "로컬 서버 (OpenAI 호환)",
                })
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
                onDiscover: () =>
                  Promise.resolve([
                    { id: "served-model", contextWindow: 131_072 },
                    { id: "other" },
                  ]),
              }}
            />
          </div>,
          withI18n,
        ),
      );
      const endpoint = screen.getByRole("listitem", {
        name: "로컬 서버 (OpenAI 호환)",
      });
      yield* sdkCall(() => expect.element(endpoint.getByText("사용 중")).toBeVisible());
      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 추가" }).click());
      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 목록 불러오기" }).click());
      yield* sdkCall(() => endpoint.getByRole("button", { name: "served-model" }).click());
      // The model list's context window fills the field, named by its unit and shown exactly.
      const contextWindow = endpoint.getByRole("textbox", { name: "컨텍스트 창 (토큰)" });
      yield* sdkCall(() => expect.element(contextWindow).toHaveValue("128K"));
      yield* sdkCall(() =>
        expect.element(endpoint.getByText("131,072 토큰 · 서버 모델 목록의 값")).toBeVisible(),
      );
      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 저장" }).click());

      // A typed unit reads as binary tokens; text that is no count keeps the model from saving.
      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 추가" }).click());
      yield* sdkCall(() => endpoint.getByRole("textbox", { name: "모델 ID" }).fill("typed-model"));
      const typedWindow = endpoint.getByRole("textbox", { name: "컨텍스트 창 (토큰)" });
      yield* sdkCall(() => typedWindow.fill("64q"));
      yield* sdkCall(() =>
        expect.element(endpoint.getByRole("button", { name: "모델 저장" })).toBeDisabled(),
      );
      yield* sdkCall(() => typedWindow.fill("64k"));
      yield* sdkCall(() => expect.element(endpoint.getByText("65,536 토큰")).toBeVisible());
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
            contextWindow: 131_072,
            outputBudget: null,
            toolCalling: true,
            imageInput: false,
          },
        },
        {
          intent: "save-model",
          accountId: "e",
          model: {
            id: "typed-model",
            contextWindow: 65_536,
            outputBudget: null,
            toolCalling: true,
            imageInput: false,
          },
        },
        { intent: "create", baseUrl: "https://api.example.com/v1" },
      ]);
    }),
  );

  it.live("a model's reasoning efforts start from the server's or the standard ones", () =>
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
                onDiscover: () =>
                  Promise.resolve([
                    {
                      id: "served-model",
                      reasoning: { options: ["low", "high"], default: "high" },
                    },
                  ]),
              }}
            />
          </div>,
          withI18n,
        ),
      );
      const endpoint = screen.getByRole("listitem", { name: "로컬 서버 (OpenAI 호환)" });
      const efforts = endpoint.getByRole("group", { name: "추론 단계 목록" });
      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 추가" }).click());
      yield* sdkCall(() => endpoint.getByRole("textbox", { name: "모델 ID" }).fill("typed-model"));
      // A server that names no efforts gets the standard ones, marked as unconfirmed.
      yield* sdkCall(() => expect.element(efforts.getByText("medium")).toBeVisible());
      yield* sdkCall(() =>
        expect.element(endpoint.getByText(/서버가 이 값을 받는지는 알 수 없습니다/)).toBeVisible(),
      );
      // Saving without touching the efforts keeps them unset.
      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 저장" }).click());

      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 추가" }).click());
      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 목록 불러오기" }).click());
      yield* sdkCall(() => endpoint.getByRole("button", { name: "served-model" }).click());
      yield* sdkCall(() =>
        expect.element(endpoint.getByText(/서버 모델 목록의 값입니다/)).toBeVisible(),
      );
      yield* sdkCall(() => endpoint.getByRole("button", { name: "low 빼기" }).click());
      yield* sdkCall(() => endpoint.getByRole("textbox", { name: "추론 단계" }).fill("xhigh"));
      yield* sdkCall(() => endpoint.getByRole("button", { name: "추가", exact: true }).click());
      yield* sdkCall(() => endpoint.getByRole("button", { name: "모델 저장" }).click());
      expect(changes.map((change) => change.intent === "save-model" && change.model)).toEqual([
        expect.not.objectContaining({ userReasoning: expect.anything() }),
        expect.objectContaining({
          id: "served-model",
          userReasoning: { options: ["high", "xhigh"], default: "high" },
        }),
      ]);
    }),
  );

  /** A conversation row the sidebar groups by its project, as the sessions list reads it. */
  const sessionOf = (projectId: string, id: string, title: string): Session => ({
    id,
    projectId,
    title,
    createdAt: "2026-10-01T09:00:00.000Z",
    agent: null,
    archivedAt: null,
    importedFrom: null,
    worktreePath: null,
    branch: null,
    model: null,
  });

  const group = (
    projectId: string,
    name: string,
    sessions: Session[],
    archived: Session[] = [],
  ) => ({
    projectId,
    name,
    sessions,
    archived,
    folderMissing: false,
  });

  /**
   * A project's header button by the project's name. The header's + button is named after the
   * project too ("Alpha에 새 대화"), so the name must not be followed by it.
   */
  const headerName = (name: string) => new RegExp(`^${name}(?!에 새 대화)`, "u");

  /** No conversation of any project is at work; tests that need one name their own. */
  const idle: Array<ProjectWorking> = [];
  /** One conversation of a project answering now, as the working reads report it. */
  const answeringIn = (projectId: string, sessionId: string): Array<ProjectWorking> => [
    { projectId, answering: new Set([sessionId]), boardRunning: new Set() },
  ];
  /** One conversation of a project with its kanban board running. */
  const boardRunningIn = (projectId: string, sessionId: string): Array<ProjectWorking> => [
    { projectId, answering: new Set(), boardRunning: new Set([sessionId]) },
  ];

  it.live("each listed project is a collapsible group with its own conversations", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[
                group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")]),
                group("beta", "Beta", [
                  sessionOf("beta", "b1", "베타 질문"),
                  sessionOf("beta", "b2", "베타 후속"),
                ]),
                // No sessions: still a group, with its own header.
                group("gamma", "Gamma", []),
              ]}
              working={idle}
              loading={false}
              projectId="gamma"
              sessionId={null}
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );

      yield* sdkCall(() =>
        expect.element(screen.getByRole("button", { name: headerName("Alpha") })).toBeVisible(),
      );
      yield* sdkCall(() =>
        expect.element(screen.getByRole("button", { name: headerName("Beta") })).toBeVisible(),
      );
      // Gamma has no conversations, and its group is there all the same.
      yield* sdkCall(() =>
        expect.element(screen.getByRole("button", { name: headerName("Gamma") })).toBeVisible(),
      );
      // Base UI's Collapsible unmounts a closed panel, so a folded group renders no row links;
      // its header keeps only the conversation count.
      yield* sdkCall(() => expect.element(screen.getByLabelText("대화 1개")).toBeVisible());
      expect(screen.container.querySelectorAll('a[href*="session="]').length).toBe(0);
      // Opening a group mounts its rows.
      yield* sdkCall(() => screen.getByRole("button", { name: headerName("Alpha") }).click());
      yield* sdkCall(() =>
        expect.element(screen.getByRole("link", { name: "알파 대화" })).toBeVisible(),
      );
      yield* sdkCall(() => screen.getByRole("button", { name: headerName("Beta") }).click());
      yield* sdkCall(() =>
        expect.element(screen.getByRole("link", { name: "베타 질문" })).toBeVisible(),
      );
    }),
  );

  it.live("a group keeps its fold across a fresh render", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")])]}
              working={idle}
              loading={false}
              // The selected project starts open, like a first visit to the page.
              projectId="alpha"
              sessionId="a1"
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );
      yield* sdkCall(() =>
        expect.element(screen.getByRole("link", { name: "알파 대화" })).toBeVisible(),
      );

      // Folding it unmounts the rows (Base UI closes its panel) and records the fold; the next
      // visit starts folded even though it is the selected project, because the user's choice
      // outranks the default.
      yield* sdkCall(() => screen.getByRole("button", { name: headerName("Alpha") }).click());
      yield* sdkCall(() =>
        expect.element(screen.getByRole("link", { name: "알파 대화" })).not.toBeInTheDocument(),
      );
      expect(yield* storedFolds()).toEqual({ alpha: false });

      // The first render leaves the document before the second one, so the second one's queries
      // see only itself and read the fold from storage.
      yield* sdkCall(() => screen.unmount());
      const again = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")])]}
              working={idle}
              loading={false}
              projectId="alpha"
              sessionId="a1"
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );
      yield* sdkCall(() =>
        expect.element(again.getByRole("link", { name: "알파 대화" })).not.toBeInTheDocument(),
      );
      yield* sdkCall(() => again.getByRole("button", { name: headerName("Alpha") }).click());
      yield* sdkCall(() =>
        expect.element(again.getByRole("link", { name: "알파 대화" })).toBeVisible(),
      );
      expect(yield* storedFolds()).toEqual({ alpha: true });
    }),
  );

  it.live("the project header stays pinned above the section headings", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[
                group(
                  "alpha",
                  "Alpha",
                  [sessionOf("alpha", "a1", "알파 대화")],
                  [sessionOf("alpha", "a0", "알파 보관")],
                ),
              ]}
              working={idle}
              loading={false}
              projectId="alpha"
              sessionId="a1"
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );
      // The project's name pins to the list's top like the archive heading; it must sit above
      // them so a scrolling heading passes under it instead of covering it.
      // The row holding the folding trigger and the project's buttons is what pins.
      const header = screen
        .getByRole("button", { name: headerName("Alpha") })
        .element().parentElement!;
      // The section heading below the header row is also a sticky button ("보관함 {count}개").
      const heading = screen.getByRole("button", { name: /^보관함/u }).element();
      const headerStyle = getComputedStyle(header);
      const headingStyle = getComputedStyle(heading);
      expect(headerStyle.position).toBe("sticky");
      expect(headingStyle.position).toBe("sticky");
      expect(Number(headerStyle.zIndex)).toBeGreaterThan(Number(headingStyle.zIndex));
    }),
  );

  it.live("a project without conversations is a group while it is not the open project", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[
                group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")]),
                group("gamma", "Gamma", []),
              ]}
              working={idle}
              loading={false}
              projectId="alpha"
              sessionId="a1"
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );

      yield* sdkCall(() =>
        expect.element(screen.getByRole("button", { name: headerName("Gamma") })).toBeVisible(),
      );
      // Its header starts the project's first conversation.
      yield* sdkCall(() =>
        expect.element(screen.getByRole("button", { name: "Gamma에 새 대화" })).toBeVisible(),
      );
    }),
  );

  it.live("every conversation row links to its own project and session", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[
                group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")]),
                group("beta", "Beta", [sessionOf("beta", "b1", "베타 질문")]),
              ]}
              working={idle}
              loading={false}
              // The page is on beta, so the row of alpha must still open alpha's conversation.
              projectId="beta"
              sessionId="b1"
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );

      // A group folds, so its conversations are behind its header: the folded alpha has no rows,
      // and opening it mounts them.
      expect(screen.container.querySelectorAll('a[href*="session="]').length).toBe(1);
      yield* sdkCall(() => screen.getByRole("button", { name: headerName("Alpha") }).click());
      const alpha = screen.getByRole("link", { name: "알파 대화" });
      expect(alpha.element().getAttribute("href")).toBe("/?project=alpha&session=a1");
      const beta = screen.getByRole("link", { name: "베타 질문" });
      expect(beta.element().getAttribute("href")).toBe("/?project=beta&session=b1");
      // The conversation of the page in use is marked as the current one.
      expect(beta.element().getAttribute("aria-current")).toBe("page");
      expect(alpha.element().getAttribute("aria-current")).toBeNull();
    }),
  );

  it.live("archiving and deleting name the conversation's own project", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")])]}
              working={idle}
              loading={false}
              projectId="beta"
              sessionId={null}
              archiveError={null}
              onCreate={() => {}}
              onArchive={(projectId, sessionId) =>
                void asked.push(`archive:${projectId}:${sessionId}`)
              }
              onDelete={(projectId, sessionId) =>
                void asked.push(`delete:${projectId}:${sessionId}`)
              }
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );

      // A group folds, so its conversations are behind its header: open it to reach the row.
      yield* sdkCall(() => screen.getByRole("button", { name: headerName("Alpha") }).click());
      yield* sdkCall(() => screen.getByRole("button", { name: "알파 대화 메뉴" }).click());
      yield* sdkCall(() => screen.getByRole("menuitem", { name: "보관하기" }).click());
      expect(asked).toEqual(["archive:alpha:a1"]);
    }),
  );

  it.live("a conversation at work leads its group and shows its spinner", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[
                group("alpha", "Alpha", [
                  sessionOf("alpha", "a1", "알파 먼저"),
                  sessionOf("alpha", "a2", "알파 나중"),
                ]),
              ]}
              // a2 answers now: it moves ahead of a1 in the one list.
              working={answeringIn("alpha", "a2")}
              loading={false}
              projectId="alpha"
              sessionId={null}
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );

      // The selected group is open, so the rows are mounted: the answering one is first.
      const rows = [...screen.container.querySelectorAll('a[href*="session="]')];
      expect(rows.map((row) => row.textContent?.trim())).toEqual(["알파 나중", "알파 먼저"]);
      // The row carries the spinner with the answering status as its name.
      const spinning = screen.getByRole("status", { name: "답변 중" });
      expect(spinning.element().closest("a")?.textContent).toContain("알파 나중");

      // The header badge counts the project's conversations at work; its accessible name says
      // what the count is of, its content the number with a spinning marker.
      const header = screen.getByRole("button", { name: headerName("Alpha") }).element();
      const badge = header.querySelector('[data-slot="badge"][aria-label]');
      expect(badge?.getAttribute("aria-label")).toContain("진행 중 1개");
      expect(badge?.textContent).toContain("1");
      expect(badge?.querySelector('[data-slot="spinner"]')).not.toBeNull();

      // A board running instead of an answer leads too, with the board's own status.
      const again = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 먼저")])]}
              working={boardRunningIn("alpha", "a1")}
              loading={false}
              projectId="alpha"
              sessionId={null}
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );
      yield* sdkCall(() =>
        expect.element(again.getByRole("status", { name: "보드 실행 중" })).toBeVisible(),
      );
    }),
  );

  it.live("projects with a conversation at work lead the list in their own order", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[
                group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 질문")]),
                group("beta", "Beta", [sessionOf("beta", "b1", "베타 질문")]),
                group("gamma", "Gamma", [sessionOf("gamma", "g1", "감마 질문")]),
                group("delta", "Delta", []),
              ]}
              // Gamma answers and beta runs its board; alpha and delta stay quiet.
              working={[...answeringIn("gamma", "g1"), ...boardRunningIn("beta", "b1")]}
              loading={false}
              projectId={null}
              sessionId={null}
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );

      // Working projects first, each part keeping the order the server sent.
      const headers = ["Alpha", "Beta", "Gamma", "Delta"].map((name) => ({
        name,
        element: screen.getByRole("button", { name: headerName(name) }).element(),
      }));
      const inDocumentOrder = headers.toSorted((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
      expect(inDocumentOrder.map((header) => header.name)).toEqual([
        "Beta",
        "Gamma",
        "Alpha",
        "Delta",
      ]);
    }),
  );

  it.live("the header badge counts the project's own working conversations", () =>
    Effect.gen(function* () {
      const screen = yield* sdkCall(() =>
        render(
          <div className="w-72">
            <SessionSection
              groups={[
                group("alpha", "Alpha", [
                  sessionOf("alpha", "a1", "알파 질문"),
                  sessionOf("alpha", "a2", "알파 후속"),
                ]),
                group("beta", "Beta", [sessionOf("beta", "b1", "베타 질문")]),
              ]}
              // Two of alpha's conversations work; beta's stays quiet.
              working={[
                {
                  projectId: "alpha",
                  answering: new Set(["a1"]),
                  boardRunning: new Set(["a2"]),
                },
                { projectId: "beta", answering: new Set(), boardRunning: new Set() },
              ]}
              loading={false}
              projectId="alpha"
              sessionId={null}
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
          withSidebar,
        ),
      );

      // Alpha's badge counts both kinds of work; beta's has no badge at all.
      const alphaHeader = screen.getByRole("button", { name: headerName("Alpha") }).element();
      const betaHeader = screen.getByRole("button", { name: headerName("Beta") }).element();
      const alphaBadge = alphaHeader.querySelector('[data-slot="badge"][aria-label]');
      expect(alphaBadge?.getAttribute("aria-label")).toContain("진행 중 2개");
      expect(alphaBadge?.textContent).toContain("2");
      expect(betaHeader.querySelectorAll('[data-slot="badge"][aria-label]')).toHaveLength(0);
    }),
  );
});

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
