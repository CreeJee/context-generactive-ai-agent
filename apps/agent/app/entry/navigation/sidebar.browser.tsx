import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { Array as EffectArray } from "effect";
import { render } from "vitest-browser-react";
import { describe, expect } from "vite-plus/test";
import "../../app.css";
import { AccountLoginState, ProviderAuthState } from "../api";
import { AccountModelPanel } from "./account-model-panel";
import { AccountManagerList, QuotaStatus } from "./account-profiles";
import { AccountEntry, AccountSwitcherMenu } from "./account-switcher";
import { CompatibleAccountsList } from "./compatible-accounts";
import type { CompatibleAccountChange } from "./compatible-client";
import { navigationCopy as copy } from "./copy";
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
        expect
          .element(screen.getByRole("combobox", { name: copy.model.effortSelect }))
          .not.toBeInTheDocument(),
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
        expect
          .element(screen.getByRole("combobox", { name: copy.model.effortSelect }))
          .toBeVisible(),
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
              auth={ProviderAuthState["signed-in"]({ provider: "openai" })}
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
      alignedTerms(screen.container, [copy.model.model, copy.model.effort]);
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
              hiddenProjects={[]}
              onSelect={() => {}}
              onAdd={() => Promise.resolve(null)}
              onPickFolder={() => Promise.resolve({ _tag: "cancelled" })}
              onPermissionMode={() => {}}
              onCrossRecall={() => {}}
              onHide={() => {}}
              onRestore={() => {}}
            />
          </div>,
        ),
      );

      const trigger = screen.getByRole("button", { name: copy.project.sectionWith("Project 1") });
      expect(trigger.element().textContent).toBe("Project 1");
      yield* sdkCall(() => trigger.click());
      alignedTerms(screen.container, [
        copy.project.section,
        copy.project.permission,
        copy.project.memory,
        copy.project.list,
      ]);
    }),
  );

  it.live(
    "choosing an archived project releases it, and an open folder already listed is selected",
    () =>
      Effect.gen(function* () {
        const project = (id: string, hiddenAt: string | null) => ({
          id,
          root: `/tmp/${id}`,
          name: id,
          crossRecallExcluded: false,
          permissionMode: "ask" as const,
          createdAt: "2026-10-01T00:00:00.000Z",
          hiddenAt,
        });
        const events: string[] = [];
        // The section's open state persists across tests; start closed like a first visit.
        yield* Effect.sync(() => localStorage.removeItem("context-agent-project-section-open-v2"));
        const screen = yield* sdkCall(() =>
          render(
            <div className="w-72">
              <ProjectSection
                projects={[project("alpha", null)]}
                hiddenProjects={[project("beta", "2026-10-02T00:00:00.000Z")]}
                projectId="alpha"
                onSelect={(id) => void events.push(`select:${id}`)}
                onAdd={(root) => Promise.resolve(void events.push(`add:${root}`)).then(() => null)}
                onPickFolder={() => Promise.resolve({ _tag: "picked", root: "/tmp/alpha" })}
                onPermissionMode={() => {}}
                onCrossRecall={() => {}}
                onHide={() => {}}
                onRestore={(id) => void events.push(`restore:${id}`)}
              />
            </div>,
          ),
        );
        yield* sdkCall(() =>
          screen.getByRole("button", { name: copy.project.sectionWith("alpha") }).click(),
        );
        yield* sdkCall(() => screen.getByRole("combobox", { name: copy.project.choose }).click());
        yield* sdkCall(() => screen.getByRole("option", { name: /beta/ }).click());
        yield* sdkCall(() => screen.getByRole("button", { name: copy.project.openFolder }).click());
        yield* sdkCall(() => expect.poll(() => events).toEqual(["restore:beta", "select:alpha"]));
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
        ),
      );

      const personal = screen.getByRole("listitem", { name: "개인 (ChatGPT)" });
      yield* sdkCall(() => expect.element(personal.getByText(copy.inUse)).toBeVisible());
      yield* sdkCall(() =>
        expect.element(personal.getByText(copy.quota.unavailable.credential_expired)).toBeVisible(),
      );
      // Only the provider in use has an account in use, though each provider keeps a selection.
      const work = screen.getByRole("listitem", { name: "회사 (Claude)" });
      yield* sdkCall(() => expect.element(work.getByText(copy.inUse)).not.toBeInTheDocument());
      yield* sdkCall(() =>
        expect
          .element(work.getByRole("meter", { name: copy.quota.window.fiveHour }))
          .toHaveAttribute("aria-valuenow", "37"),
      );
      yield* sdkCall(() => work.getByRole("button", { name: copy.rename.openFor("회사") }).click());
      yield* sdkCall(() => work.getByRole("textbox", { name: copy.rename.field }).fill("팀"));
      yield* sdkCall(() => work.getByRole("button", { name: copy.rename.save }).click());

      yield* sdkCall(() =>
        screen.getByRole("button", { name: copy.subscriptionAccounts.addFor("ChatGPT") }).click(),
      );
      yield* sdkCall(() =>
        screen.getByRole("textbox", { name: copy.addAccount.name }).fill("부계정"),
      );
      yield* sdkCall(() => screen.getByRole("button", { name: copy.addAccount.submit }).click());
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
          ),
        );

        yield* sdkCall(() =>
          screen.getByRole("button", { name: copy.switcher.openWith("개인", "ChatGPT") }).click(),
        );
        const work = screen.getByRole("menuitem", { name: "회사 (Claude)" });
        yield* sdkCall(() => expect.element(work.getByText("37%")).toBeVisible());
        yield* sdkCall(() =>
          expect
            .element(
              screen
                .getByRole("menuitem", {
                  name: `로컬 서버 (${copy.providerLabels["openai-compatible"]})`,
                })
                .getByText(copy.switcher.noModels),
            )
            .toBeVisible(),
        );
        yield* sdkCall(() => work.click());
        expect(switched).toEqual([{ provider: "anthropic", accountId: "c" }]);
        yield* sdkCall(() => screen.getByRole("button", { name: copy.switcher.manage }).click());
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
      const endpoint = screen.getByRole("listitem", {
        name: copy.compatible.endpoint.row("로컬 서버"),
      });
      yield* sdkCall(() => expect.element(endpoint.getByText(copy.inUse)).toBeVisible());
      yield* sdkCall(() =>
        endpoint.getByRole("button", { name: copy.compatible.endpoint.addModel }).click(),
      );
      yield* sdkCall(() =>
        endpoint.getByRole("button", { name: copy.compatible.modelForm.discover }).click(),
      );
      yield* sdkCall(() => endpoint.getByRole("button", { name: "served-model" }).click());
      yield* sdkCall(() =>
        endpoint.getByRole("button", { name: copy.compatible.modelForm.save }).click(),
      );

      yield* sdkCall(() =>
        screen.getByRole("button", { name: copy.compatible.list.addFor }).click(),
      );
      yield* sdkCall(() =>
        screen.getByRole("textbox", { name: "Base URL" }).fill("https://api.example.com/v1"),
      );
      yield* sdkCall(() =>
        screen.getByRole("button", { name: copy.compatible.addEndpoint.submit }).click(),
      );
      expect(changes).toEqual([
        {
          intent: "save-model",
          accountId: "e",
          model: {
            id: "served-model",
            contextWindow: 32768,
            outputBudget: null,
            toolCalling: true,
            imageInput: false,
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
