import { Effect } from "effect";
import { runUiEffect, uiPromise, uiFailure } from "./shared/ui-effect";
import { isTruthy } from "../truthy.ts";
import { useAuthQuery, useModelsQuery, useProjectsQuery } from "./queries/global";
import {
  useAddProjectMutation,
  useAuthActionMutation,
  useSelectModelMutation,
  useSwitchAccountMutation,
  type AccountTarget,
} from "./queries/mutations/global";
import {
  useCreateSessionMutation,
  useCrossRecallMutation,
  useHideProjectMutation,
  usePermissionModeMutation,
  useSessionLifecycleMutation,
} from "./queries/mutations/project";
import {
  useAgentsQuery,
  useProjectSessionsQuery,
  useSkillsQuery,
  usableAgents,
} from "./queries/project";
import { FolderIcon, LogInIcon, SettingsIcon } from "lucide-react";
import { match, P } from "ts-pattern";
import { parseAsString, useQueryStates } from "nuqs";
import { useEffect, useState } from "react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Separator } from "~/components/ui/separator";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  archiveErrorMessage,
  projectErrorMessage,
  type ModelSelection,
  type ProviderId,
} from "./api";
import { SessionView, type SlashSupport } from "./chat/chat-panel";
import { AppEventsProvider, SessionEventsProvider } from "./events/providers";
import { ThemeSelect } from "./shared/theme";
import { pageHolder } from "./session/session-lease";
import { openSettingsOverlay } from "./settings/open-settings";
import { AccountSection, ModelSection, ProjectSection, SessionSection } from "./navigation/sidebar";
import { AccountModelPanel } from "./navigation/account-model-panel";
import { SubscriptionAccounts } from "./navigation/account-profiles";
import { AccountSwitcher } from "./navigation/account-switcher";
import { WorkTracePanel } from "./chat/work-trace-panel";
import { BtwPanel } from "./chat/btw-panel";
import { ReportLink, reportHref } from "./report/report-link";
import { providerLabels } from "./navigation/providers";

const locationParsers = {
  project: parseAsString,
  session: parseAsString,
};

function Placeholder({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function App() {
  const openAIAuth = useAuthQuery("openai");
  const anthropicAuth = useAuthQuery("anthropic");
  const compatibleAuth = useAuthQuery("openai-compatible");
  const auth = {
    openai: openAIAuth.data ?? null,
    anthropic: anthropicAuth.data ?? null,
    "openai-compatible": compatibleAuth.data ?? null,
  };
  const [provider, setProvider] = useState<ProviderId>("openai");
  const openAIModels = useModelsQuery("openai", auth.openai?.status === "signed-in");
  const anthropicModels = useModelsQuery("anthropic", auth.anthropic?.status === "signed-in");
  const compatibleModels = useModelsQuery(
    "openai-compatible",
    compatibleAuth.data?.status === "signed-in",
  );
  const modelQueries = {
    openai: openAIModels,
    anthropic: anthropicModels,
    "openai-compatible": compatibleModels,
  };
  const models = modelQueries[provider].data?.models ?? [];
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const projectsQuery = useProjectsQuery();
  const projects = projectsQuery.data ?? [];
  const [{ project: projectId, session: sessionId }, setLocation] = useQueryStates(locationParsers);
  const authMutation = useAuthActionMutation(provider);
  const addProjectMutation = useAddProjectMutation();
  const modelMutation = useSelectModelMutation(provider);
  const switchMutation = useSwitchAccountMutation();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const permissionMutation = usePermissionModeMutation(projectId ?? "");
  const crossRecallMutation = useCrossRecallMutation(projectId ?? "");
  const hideProjectMutation = useHideProjectMutation();
  const createSessionMutation = useCreateSessionMutation(projectId ?? "");
  const lifecycleMutation = useSessionLifecycleMutation(projectId ?? "", pageHolder);
  const sessionsQuery = useProjectSessionsQuery(projectId);
  const sessions = sessionsQuery.data?.active ?? [];
  const archived = sessionsQuery.data?.archived ?? [];
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const agentsQuery = useAgentsQuery(projectId);
  const skillsQuery = useSkillsQuery(projectId ?? "", projectId !== null);
  const slashAgents = isTruthy(agentsQuery.data) ? usableAgents(agentsQuery.data) : [];
  const slashSkills =
    skillsQuery.data?.skills.map(({ name, description }) => ({ name, description })) ?? [];

  useEffect(() => {
    if (!isTruthy(projectsQuery.data)) return;
    void setLocation((current) => {
      const project = projects.some((item) => item.id === current.project)
        ? current.project
        : (projects[0]?.id ?? null);
      return {
        project,
        session: project === current.project ? current.session : null,
      };
    });
  }, [projects, projectsQuery.data, setLocation]);

  const signedIn = auth[provider]?.status === "signed-in";
  const selectedSignedIn = selection !== null && auth[selection.provider]?.status === "signed-in";
  useEffect(() => {
    const selected =
      modelQueries[provider].data?.selected ??
      Object.values(modelQueries).find((query) => query.data?.selected)?.data?.selected;
    if (isTruthy(selected)) {
      setSelection(selected);
      setProvider(selected.provider);
    }
  }, [
    openAIModels.data?.selected,
    anthropicModels.data?.selected,
    compatibleModels.data?.selected,
  ]);

  useEffect(() => {
    if (!isTruthy(projectId) || !isTruthy(sessionsQuery.data)) return;
    void setLocation((current) =>
      current.project === projectId
        ? {
            session: sessions.some((item) => item.id === current.session)
              ? current.session
              : (sessions[0]?.id ?? null),
          }
        : {},
    );
  }, [projectId, sessions, sessionsQuery.data, setLocation]);

  const selectProject = (id: string) =>
    void setLocation({ project: id, session: null }, { history: "push" });
  useEffect(() => setArchiveError(null), [projectId]);

  const refreshPendingLifecycle = (status: "waiting_for_stop" | "blocked") => {
    setArchiveError(
      status === "waiting_for_stop"
        ? "실행이 멈추기를 기다리고 있어요. 아직 대화를 바꾸지 않았어요."
        : "지금은 대화를 바꿀 수 없어요. 실행 상태를 확인한 뒤 다시 시도하세요.",
    );
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const archiveSession = (id: string) =>
    runUiEffect(
      Effect.gen(function* () {
        if (!isTruthy(projectId)) return;
        return yield* Effect.gen(function* () {
          const result = yield* uiPromise(() =>
            lifecycleMutation.mutateAsync({ kind: "archive", sessionId: id }),
          );
          if (result.status !== "completed") return refreshPendingLifecycle(result.status);
          setArchiveError(null);
          const remaining = sessions.filter((item) => item.id !== id);
          if (sessionId === id) void setLocation({ session: remaining[0]?.id ?? null });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              const error = uiFailure(cause);
              setArchiveError(
                archiveErrorMessage(error instanceof Error ? error : new Error(String(error))),
              );
            }),
          ),
        );
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const deleteSession = (id: string) =>
    runUiEffect(
      Effect.gen(function* () {
        if (!isTruthy(projectId)) return;
        return yield* Effect.gen(function* () {
          const result = yield* uiPromise(() =>
            lifecycleMutation.mutateAsync({ kind: "delete", sessionId: id }),
          );
          if (result.status !== "completed") return refreshPendingLifecycle(result.status);
          setArchiveError(null);
          const remaining = sessions.filter((item) => item.id !== id);
          if (sessionId === id) void setLocation({ session: remaining[0]?.id ?? null });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              const error = uiFailure(cause);
              setArchiveError(
                archiveErrorMessage(error instanceof Error ? error : new Error(String(error))),
              );
            }),
          ),
        );
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const restoreSession = (id: string) =>
    runUiEffect(
      Effect.gen(function* () {
        if (!isTruthy(projectId)) return;
        return yield* Effect.gen(function* () {
          const result = yield* uiPromise(() =>
            lifecycleMutation.mutateAsync({ kind: "restore", sessionId: id }),
          );
          if (result.status !== "completed") return refreshPendingLifecycle(result.status);
          setArchiveError(null);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              const error = uiFailure(cause);
              setArchiveError(
                archiveErrorMessage(error instanceof Error ? error : new Error(String(error))),
              );
            }),
          ),
        );
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const authAction = (intent: "login" | "cancel" | "logout") =>
    runUiEffect(
      Effect.gen(function* () {
        const state = yield* uiPromise(() => authMutation.mutateAsync(intent));
        if (state.status === "pending") window.open(state.authUrl, "_blank", "noopener");
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const addProject = (root: string) =>
    runUiEffect(
      Effect.gen(function* () {
        const project = yield* uiPromise(() => addProjectMutation.mutateAsync(root));
        void setLocation({ project: project.id, session: null }, { history: "push" });
        return null;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = uiFailure(cause);
            return projectErrorMessage(error instanceof Error ? error : new Error(String(error)));
          }),
        ),
      ),
    );

  const openSettings = () =>
    openSettingsOverlay({ project: projects.find((item) => item.id === projectId) ?? null });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const selectModel = (model: string, effort?: string) =>
    runUiEffect(
      Effect.gen(function* () {
        const selected = yield* uiPromise(() => modelMutation.mutateAsync({ model, effort }));
        setSelection(selected);
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const switchAccount = (target: AccountTarget) =>
    runUiEffect(
      Effect.gen(function* () {
        setSwitchError(null);
        const selected = yield* uiPromise(() =>
          switchMutation.mutateAsync({
            target,
            selectModel: selection?.provider !== target.provider,
          }),
        );
        setProvider(target.provider);
        if (selected !== null) setSelection(selected);
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() =>
            setSwitchError("계정을 바꾸지 못했어요. 연결 상태를 확인한 뒤 다시 시도하세요."),
          ),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const createSession = (agent?: string) =>
    runUiEffect(
      Effect.gen(function* () {
        if (!isTruthy(projectId)) return;
        const session = yield* uiPromise(() => createSessionMutation.mutateAsync(agent));
        void setLocation({ session: session.id }, { history: "push" });
      }),
    );

  const slash: SlashSupport = {
    context: {
      agents: slashAgents,
      models: models.map((model) => ({ id: model.id, label: model.displayName })),
      skills: slashSkills,
    },
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    run: (command) =>
      runUiEffect(
        Effect.gen(function* () {
          switch (command.kind) {
            case "new":
              return yield* uiPromise(() => createSession());
            case "agent":
              return yield* uiPromise(() => createSession(command.agent));
            case "settings":
              return openSettings();
            case "report":
              window.location.assign(reportHref(projectId, sessionId));
              return;
            case "mode":
              if (isTruthy(projectId))
                yield* uiPromise(() => permissionMutation.mutateAsync(command.mode));
              return;
            case "model":
              yield* uiPromise(() => selectModel(command.model));
              return;
          }
        }),
      ),
  };

  const main = match({ selection, signedIn, selectedSignedIn, projectId, sessionId })
    // Local history does not depend on the provider's remote model catalogue.
    // Keep model/auth readiness on mutations, not on mounting the session reader.
    .with({ projectId: P.string, sessionId: P.string }, ({ sessionId: id }) => (
      <SessionView
        key={id}
        sessionId={id}
        slash={slash}
        sendingEnabled={selectedSignedIn}
        imagesSupported={
          selection !== null &&
          sessions.find((session) => session.id === id)?.agent == null &&
          ((modelQueries[selection.provider].data?.models ?? [])
            .find((model) => model.id === selection.model)
            ?.capabilities.inputModalities.includes("image") ??
            false)
        }
      />
    ))
    .with({ selection: null, signedIn: false }, () => (
      <Placeholder
        icon={<LogInIcon />}
        title="공급자를 연결하세요"
        description="왼쪽에서 구독 계정에 로그인하거나 OpenAI 호환 공급자를 설정하세요."
      />
    ))
    .with({ selection: null }, () => (
      <Placeholder
        icon={<LogInIcon />}
        title="모델을 선택하세요"
        description="계정에서 쓸 수 있는 모델 중 하나를 고르세요."
      />
    ))
    .with({ selection: P.nonNullable, selectedSignedIn: false }, ({ selection: selected }) => (
      <Placeholder
        icon={<LogInIcon />}
        title={
          selected.provider === "openai-compatible"
            ? "호환 공급자를 설정하세요"
            : "선택한 공급자에 로그인하세요"
        }
        description={`${providerLabels[selected.provider]} 연결이 필요해요.`}
      />
    ))
    .with({ projectId: null }, () => (
      <Placeholder
        icon={<FolderIcon />}
        title="프로젝트를 추가하세요"
        description="대화와 기억은 프로젝트 단위로 저장돼요."
      />
    ))
    .with({ sessionId: null }, () => (
      <Placeholder
        icon={<FolderIcon />}
        title="새 대화를 시작하세요"
        description="왼쪽의 새 대화 버튼을 누르세요."
      />
    ))
    .exhaustive();

  return (
    <AppEventsProvider>
      <SessionEventsProvider projectId={projectId} sessionId={sessionId}>
        <div className="flex h-dvh bg-background text-foreground">
          <aside className="flex min-h-0 w-72 shrink-0 flex-col overflow-hidden border-r">
            <div className="flex items-center gap-1 py-1 pr-2 pl-3">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">Context Agent</span>
              <ReportLink projectId={projectId} sessionId={sessionId} />
              <ThemeSelect />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="설정"
                title="설정"
                onClick={openSettings}
              >
                <SettingsIcon />
              </Button>
            </div>
            <Separator />
            <div className="min-h-0 shrink overflow-y-auto overscroll-contain">
              <AccountModelPanel
                provider={provider}
                auth={auth[provider]}
                selection={selection}
                modelName={
                  selection !== null
                    ? modelQueries[selection.provider].data?.models.find(
                        (model) => model.id === selection.model,
                      )?.displayName
                    : undefined
                }
              >
                {signedIn ? (
                  <ModelSection
                    models={models}
                    selection={selection?.provider === provider ? selection : null}
                    onSelect={(model, effort) => void selectModel(model, effort)}
                  />
                ) : (
                  <div className="flex flex-col gap-2 p-3 text-xs text-muted-foreground">
                    {providerLabels[provider]} 계정을 연결하면 모델을 고를 수 있어요.
                    <Button variant="outline" size="sm" onClick={() => setAccountsOpen(true)}>
                      계정 연결
                    </Button>
                  </div>
                )}
              </AccountModelPanel>
              <ProjectSection
                projects={projects}
                projectId={projectId}
                onSelect={selectProject}
                onAdd={addProject}
                onPermissionMode={(mode) => {
                  if (!isTruthy(projectId)) return;
                  void permissionMutation.mutateAsync(mode);
                }}
                onCrossRecall={(allowed) => {
                  if (!isTruthy(projectId)) return;
                  void crossRecallMutation.mutateAsync(!allowed);
                }}
                onHide={(hiddenId) => {
                  void hideProjectMutation.mutateAsync(hiddenId).then(() => {
                    const left = projects.filter((project) => project.id !== hiddenId);
                    void setLocation({ project: left.at(0)?.id ?? null, session: null });
                  });
                }}
              />
            </div>
            <Separator />
            {projectId && (
              <SessionSection
                sessions={sessions}
                archived={archived}
                projectId={projectId}
                sessionId={sessionId}
                archiveError={archiveError}
                onCreate={(agent) => void createSession(agent)}
                onArchive={(id) => void archiveSession(id)}
                onDelete={(id) => void deleteSession(id)}
                onRestore={(id) => void restoreSession(id)}
                agents={slashAgents}
              />
            )}
            <div className="mt-auto">
              <AccountSwitcher
                activeProvider={selection?.provider ?? provider}
                compatibleAuth={auth["openai-compatible"]}
                busy={switchMutation.isPending}
                error={switchError}
                onSwitch={(target) => void switchAccount(target)}
                onConfigureCompatible={() =>
                  openSettingsOverlay({ project: null, initialPage: "compatible" })
                }
                onManage={() => setAccountsOpen(true)}
              />
            </div>
            <Dialog open={accountsOpen} onOpenChange={setAccountsOpen}>
              <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>계정 추가·관리</DialogTitle>
                  <DialogDescription>
                    공급자별로 계정을 추가하고, 계정마다 ⋯ 메뉴에서 이름을 바꾸거나 로그아웃해요.
                  </DialogDescription>
                </DialogHeader>
                <AccountSection
                  auth={auth[provider]}
                  provider={provider}
                  onProviderChange={setProvider}
                  onAction={(intent) => void authAction(intent)}
                  profiles={
                    provider === "openai-compatible" ? undefined : (
                      <SubscriptionAccounts key={provider} provider={provider} />
                    )
                  }
                />
              </DialogContent>
            </Dialog>
          </aside>
          <main className="min-w-0 flex-1">{main}</main>
          {projectId && sessionId && selection && (
            <BtwPanel key={sessionId} projectId={projectId} sessionId={sessionId} />
          )}
          {projectId && <WorkTracePanel projectId={projectId} sessionId={sessionId} />}
        </div>
      </SessionEventsProvider>
    </AppEventsProvider>
  );
}
