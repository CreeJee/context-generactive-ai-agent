import { ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect, Match, Predicate } from "effect";
import { runUiEffect, uiPromise } from "./shared/ui-effect";
import { isTruthy } from "../truthy.ts";
import {
  useAccountsQuery,
  useAuthQuery,
  useCompatibleAccountsQuery,
  useHiddenProjectsQuery,
  useModelsQuery,
  useProjectsQuery,
} from "./queries/global";
import { api, ProviderAuthState } from "./api";
import {
  useAddProjectMutation,
  useSelectModelMutation,
  useSwitchAccountMutation,
  type AccountTarget,
} from "./queries/mutations/global";
import {
  useCreateSessionMutation,
  usePermissionModeMutation,
  useRestoreProjectMutation,
  SessionLifecycleChange,
  useSessionLifecycleMutation,
} from "./queries/mutations/project";
import {
  useAgentsQuery,
  useAllProjectSessions,
  useAllWorkingSessions,
  useProjectSessionsQuery,
  useSkillsQuery,
  usableAgents,
} from "./queries/project";
import { FolderIcon, LogInIcon, SettingsIcon, UserIcon } from "lucide-react";
import { match, P } from "ts-pattern";
import { parseAsBoolean, parseAsString, useQueryStates } from "nuqs";
import { useEffect, useState } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import {
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "~/components/ui/sidebar";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import {
  archiveErrorMessage,
  projectErrorMessage,
  refusalOf,
  type ModelSelection,
  type PendingLifecycle,
  type ProviderId,
} from "./api";
import { ChatHeader } from "./chat/chat-header";
import { SessionView, type SlashSupport } from "./chat/chat-panel";
import { AppEventsProvider, SessionEventsProvider } from "./events/providers";
import { ThemeSelect } from "./shared/theme";
import { pageHolder } from "./session/session-lease";
import { openSettingsOverlay } from "./settings/open-settings";
import {
  ArchivedProjects,
  ModelSection,
  OpenFolderButton,
  SessionSection,
  sessionLabel,
} from "./navigation/sidebar";
import { DecisionInbox } from "./navigation/decision-inbox";
import { ProjectMenu } from "./navigation/project-menu";
import { boardCardKey, parseBoardCardKey } from "./chat/board/board-moves";
import { ProjectBoard } from "./chat/board/project-board";
import { AccountModelPanel } from "./navigation/account-model-panel";
import { AccountManager } from "./navigation/account-profiles";
import { CompatibleAccounts } from "./navigation/compatible-accounts";
import { AccountSwitcher } from "./navigation/account-switcher";
import { WorkTracePanel } from "./chat/work-trace-panel";
import { BtwPanel } from "./chat/btw-panel";
import { ReportLink, reportHref } from "./report/report-link";
import { RetryButton } from "./shared/load-failed";
import { useHydrated } from "./shared/use-hydrated";
import { ModelDownloadList } from "./shared/model-downloads";
import { effortChoices, providerLabels } from "./navigation/providers";

const locationParsers = {
  project: parseAsString,
  session: parseAsString,
  /** A board card the inbox opened; the session's board opens on it. */
  card: parseAsString,
  /** The session's board, opened from the project board's lane. */
  board: parseAsBoolean,
  /** The project board: every conversation's board as a lane, opened from the sidebar. */
  boards: parseAsBoolean,
  /** A card the project board peeks, as `sessionId:cardId`. */
  boardCard: parseAsString,
};

/** Entering a session's board closes the project board, so the two never share a URL. */
const leaveProjectBoard = { boards: null, boardCard: null } as const;
/** Changing project drops every session and board of the one left. */
const leaveProject = {
  ...leaveProjectBoard,
  session: null,
  card: null,
  board: null,
} as const;

/** Opens the sidebar again once it is folded away, or on a narrow screen where it is a sheet. */
function SidebarReopen() {
  const { open, isMobile } = useSidebar();
  const { t } = useLingui();
  return open && !isMobile ? null : (
    <div className="absolute top-2 left-2 z-20">
      <SidebarTrigger aria-label={t`사이드바 펼치기`} title={t`사이드바 펼치기 (⌘B)`} />
    </div>
  );
}

function Placeholder({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  /** What the sidebar would do about it, offered here too. */
  action?: React.ReactNode;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action !== undefined && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function App() {
  const { t } = useLingui();
  const openAIAuth = useAuthQuery("openai");
  const anthropicAuth = useAuthQuery("anthropic");
  const compatibleAuth = useAuthQuery("openai-compatible");
  const auth = {
    openai: openAIAuth.data ?? null,
    anthropic: anthropicAuth.data ?? null,
    "openai-compatible": compatibleAuth.data ?? null,
  };
  const [provider, setProvider] = useState<ProviderId>("openai");
  const signedInAuth = ProviderAuthState.$is("signed-in");
  const openAIModels = useModelsQuery("openai", signedInAuth(auth.openai));
  const anthropicModels = useModelsQuery("anthropic", signedInAuth(auth.anthropic));
  const compatibleModels = useModelsQuery("openai-compatible", signedInAuth(compatibleAuth.data));
  const modelQueries = {
    openai: openAIModels,
    anthropic: anthropicModels,
    "openai-compatible": compatibleModels,
  };
  const models = modelQueries[provider].data?.models ?? [];
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const projectsQuery = useProjectsQuery();
  const projects = projectsQuery.data ?? [];
  const hiddenProjects = useHiddenProjectsQuery().data ?? [];
  const [
    { project: projectId, session: sessionId, boards: boardsOpen, boardCard: boardCardKeyParam },
    setLocation,
  ] = useQueryStates(locationParsers);
  const addProjectMutation = useAddProjectMutation();
  const modelMutation = useSelectModelMutation(provider);
  const switchMutation = useSwitchAccountMutation();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const permissionMutation = usePermissionModeMutation(projectId ?? "");
  const restoreProjectMutation = useRestoreProjectMutation();
  const createSessionMutation = useCreateSessionMutation();
  const lifecycleMutation = useSessionLifecycleMutation(pageHolder);
  const sessionsQuery = useProjectSessionsQuery(projectId);
  const sessions = sessionsQuery.data?.active ?? [];
  /** One group per listed project: its conversations, read with each project's own query key. */
  const groups = useAllProjectSessions(
    projects.map((project) => ({ id: project.id, name: project.name })),
  );
  // An archived conversation can still be opened by its address, so its group's archive is read too.
  const openSession =
    groups
      .flatMap((group) => [...group.sessions, ...group.archived])
      .find((session) => session.id === sessionId) ?? null;
  const hydrated = useHydrated();
  /**
   * Conversations at work now, per project: the groups lead with them and badge their count.
   * Every listed project is read, not only the selected one, so a group answers from its own read.
   */
  const working = useAllWorkingSessions(projects.map((project) => ({ id: project.id })));
  // No group yet means nothing to show: either everything is still loading, or a read failed.
  // The selected project's own read leads the loading and failure states, as it did before.
  const sessionsLoading =
    groups.length === 0 && (sessionsQuery.isPending || projectsQuery.isPending);
  const sessionsFailed =
    groups.length === 0 &&
    (sessionsQuery.isError || (projectsQuery.isSuccess && projects.length > 0));
  const retrySessions = () => {
    void sessionsQuery.refetch();
    void projectsQuery.refetch();
  };
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  /** The groups the list draws: each carries whether its project's folder is gone. */
  const listed = groups.map((group) => ({
    ...group,
    folderMissing: projects.find((item) => item.id === group.projectId)?.folderMissing === true,
  }));
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

  const signedIn = signedInAuth(auth[provider]);
  const providerName = t(providerLabels[provider]);
  const selectedSignedIn = selection !== null && signedInAuth(auth[selection.provider]);
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

  // The account each provider would run on; the switcher lists the same queries.
  const openAIAccounts = useAccountsQuery("openai", true);
  const anthropicAccounts = useAccountsQuery("anthropic", true);
  const compatibleAccounts = useCompatibleAccountsQuery();
  const selectedAccountIds = {
    openai: openAIAccounts.data?.profiles.find((profile) => profile.selected)?.id,
    anthropic: anthropicAccounts.data?.profiles.find((profile) => profile.selected)?.id,
    "openai-compatible": compatibleAccounts.data?.accounts.find((account) => account.selected)?.id,
  };
  const providerOrder = ["openai", "anthropic", "openai-compatible"] as const;
  const usableSelection = providerOrder.some(
    (candidate) =>
      signedInAuth(auth[candidate]) && isTruthy(modelQueries[candidate].data?.selected),
  );
  /**
   * With no usable account in use, the first account that is signed in and has a model to run
   * on; a first login, or a first endpoint with its first model, then starts being used as a
   * switch from the account switcher would.
   */
  const firstUsableAccount =
    signedIn || selectedSignedIn || usableSelection
      ? undefined
      : providerOrder
          .flatMap((candidate): AccountTarget[] => {
            const accountId = selectedAccountIds[candidate];
            return accountId !== undefined &&
              signedInAuth(auth[candidate]) &&
              (modelQueries[candidate].data?.models.length ?? 0) > 0
              ? [{ provider: candidate, accountId }]
              : [];
          })
          .at(0);
  const firstUsableKey =
    firstUsableAccount === undefined
      ? null
      : `${firstUsableAccount.provider}:${firstUsableAccount.accountId}`;
  useEffect(() => {
    if (firstUsableAccount !== undefined) void switchAccount(firstUsableAccount);
  }, [firstUsableKey]);

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
    void setLocation({ ...leaveProject, project: id }, { history: "push" });
  useEffect(() => {
    setArchiveError(null);
  }, [projectId]);

  const refreshPendingLifecycle = (pending: PendingLifecycle) => {
    setArchiveError(
      Match.valueTags(pending, {
        waiting_for_stop: () =>
          t`실행이 멈추기를 기다리고 있습니다. 아직 대화를 바꾸지 않았습니다.`,
        blocked: ({ blocker }) =>
          blocker === "goal_dependents"
            ? t`다른 Goal 보드가 이 대화의 Goal이 merge되기를 기다리고 있습니다. 그 보드에서 의존을 먼저 풀어 주십시오.`
            : t`지금은 대화를 바꿀 수 없습니다. 실행 상태를 확인한 뒤 다시 시도해 주십시오.`,
      }),
    );
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const archiveSession = (rowProjectId: string, id: string) =>
    runUiEffect(
      Effect.gen(function* () {
        const result = yield* uiPromise(() =>
          lifecycleMutation(rowProjectId).mutateAsync(
            SessionLifecycleChange.archive({ sessionId: id }),
          ),
        );
        if (!Predicate.isTagged(result, "completed")) return refreshPendingLifecycle(result);
        setArchiveError(null);
        const remaining = sessions.filter((item) => item.id !== id);
        if (projectId === rowProjectId && sessionId === id)
          void setLocation({ session: remaining[0]?.id ?? null });
      }).pipe(
        Effect.catchTag("UnknownError", (failure) =>
          Effect.sync(() => setArchiveError(archiveErrorMessage(refusalOf(failure.cause)))),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const deleteSession = (rowProjectId: string, id: string) =>
    runUiEffect(
      Effect.gen(function* () {
        const result = yield* uiPromise(() =>
          lifecycleMutation(rowProjectId).mutateAsync(
            SessionLifecycleChange.delete({ sessionId: id }),
          ),
        );
        if (!Predicate.isTagged(result, "completed")) return refreshPendingLifecycle(result);
        setArchiveError(null);
        const remaining = sessions.filter((item) => item.id !== id);
        if (projectId === rowProjectId && sessionId === id)
          void setLocation({ session: remaining[0]?.id ?? null });
      }).pipe(
        Effect.catchTag("UnknownError", (failure) =>
          Effect.sync(() => setArchiveError(archiveErrorMessage(refusalOf(failure.cause)))),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const restoreSession = (rowProjectId: string, id: string) =>
    runUiEffect(
      Effect.gen(function* () {
        const result = yield* uiPromise(() =>
          lifecycleMutation(rowProjectId).mutateAsync(
            SessionLifecycleChange.restore({ sessionId: id }),
          ),
        );
        if (!Predicate.isTagged(result, "completed")) return refreshPendingLifecycle(result);
        setArchiveError(null);
      }).pipe(
        Effect.catchTag("UnknownError", (failure) =>
          Effect.sync(() => setArchiveError(archiveErrorMessage(refusalOf(failure.cause)))),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const addProject = (root: string) =>
    runUiEffect(
      Effect.gen(function* () {
        const project = yield* uiPromise(() => addProjectMutation.mutateAsync(root));
        void setLocation({ ...leaveProject, project: project.id }, { history: "push" });
        return null;
      }).pipe(
        Effect.catchTag("UnknownError", (failure) =>
          Effect.succeed(projectErrorMessage(refusalOf(failure.cause))),
        ),
      ),
    );

  const openSettings = () => openSettingsOverlay({ projectId });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const selectModel = (model: string, effort?: string) =>
    runUiEffect(
      Effect.gen(function* () {
        setModelError(null);
        const selected = yield* uiPromise(() => modelMutation.mutateAsync({ model, effort }));
        setSelection(selected);
      }).pipe(
        Effect.catchTag("UnknownError", () =>
          Effect.sync(() =>
            setModelError(t`모델을 바꾸지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주십시오.`),
          ),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  /** Releases an archived project back into the list; a refusal shows above the list. */
  const restoreProject = (id: string) =>
    runUiEffect(
      uiPromise(() => restoreProjectMutation.mutateAsync(id)).pipe(
        Effect.flatMap(() => Effect.sync(() => setArchiveError(null))),
        Effect.catchTag("UnknownError", () =>
          Effect.sync(() =>
            setArchiveError(
              t`프로젝트를 보관에서 꺼내지 못했습니다. 잠시 뒤 다시 시도해 주십시오.`,
            ),
          ),
        ),
      ),
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
        Effect.catchTag("UnknownError", () =>
          Effect.sync(() =>
            setSwitchError(
              t`계정을 바꾸지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주십시오.`,
            ),
          ),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const createSession = (targetProjectId: string, agent?: string) =>
    runUiEffect(
      Effect.gen(function* () {
        const session = yield* uiPromise(() =>
          createSessionMutation.mutateAsync({ projectId: targetProjectId, agent }),
        );
        setArchiveError(null);
        void setLocation(
          { ...leaveProject, project: targetProjectId, session: session.id },
          { history: "push" },
        );
      }).pipe(
        Effect.catchTag("UnknownError", () =>
          Effect.sync(() =>
            setArchiveError(t`새 대화를 만들지 못했습니다. 잠시 뒤 다시 시도해 주십시오.`),
          ),
        ),
      ),
    );

  // `/effort` changes the model the sidebar shows, as the sidebar's effort selector does.
  const shownSelection = selection?.provider === provider ? selection : null;
  const shownModel = models.find((model) => model.id === shownSelection?.model);
  const slashEfforts =
    shownSelection === null || shownModel === undefined
      ? []
      : effortChoices(shownSelection, shownModel).map((choice) =>
          choice.id === shownSelection.reasoningEffort
            ? {
                ...choice,
                label: t({
                  message: `${ph({ effort: choice.label })} (현재)`,
                  comment: "Slash-command choice for the reasoning effort the model uses now",
                }),
              }
            : choice,
        );

  const slash: SlashSupport = {
    context: {
      agents: slashAgents,
      models: models.map((model) => ({ id: model.id, label: model.displayName })),
      efforts: slashEfforts,
      skills: slashSkills,
    },
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    run: (command) =>
      runUiEffect(
        Match.valueTags(command, {
          new: () =>
            uiPromise(() => createSession(projectId ?? "")).pipe(
              Effect.when(Effect.succeed(isTruthy(projectId))),
              Effect.asVoid,
            ),
          agent: ({ agent }) =>
            uiPromise(() => createSession(projectId ?? "", agent)).pipe(
              Effect.when(Effect.succeed(isTruthy(projectId))),
              Effect.asVoid,
            ),
          settings: () => Effect.sync(openSettings),
          report: () => Effect.sync(() => window.location.assign(reportHref(projectId, sessionId))),
          mode: ({ mode }) =>
            uiPromise(() => permissionMutation.mutateAsync(mode)).pipe(
              Effect.when(Effect.succeed(isTruthy(projectId))),
              Effect.asVoid,
            ),
          model: ({ model }) => uiPromise(() => selectModel(model)),
          effort: ({ effort }) =>
            shownSelection === null
              ? Effect.void
              : uiPromise(() => selectModel(shownSelection.model, effort)),
        }),
      ),
  };

  const authQueries = {
    openai: openAIAuth,
    anthropic: anthropicAuth,
    "openai-compatible": compatibleAuth,
  };
  // A failed read must not look like a provider that is not connected or an empty project list.
  const authFailed = authQueries[provider].isError;
  const projectsFailed = projectsQuery.isError;
  const main = match({
    selection,
    signedIn,
    selectedSignedIn,
    projectId,
    sessionId,
    authFailed,
    projectsFailed,
  })
    // Local history does not depend on the provider's remote model catalogue.
    // Keep model/auth readiness on mutations, not on mounting the session reader.
    .with(
      { projectId: P.string, sessionId: P.string },
      ({ projectId: openProjectId, sessionId: id }) => (
        <div className="flex h-full min-h-0 flex-col">
          <ChatHeader
            title={openSession === null ? t`제목 없는 대화` : sessionLabel(hydrated)(openSession)}
            projectName={projects.find((item) => item.id === openProjectId)?.name ?? null}
          >
            {selection && <BtwPanel key={id} projectId={openProjectId} sessionId={id} />}
            <WorkTracePanel key={id} projectId={openProjectId} sessionId={id} />
          </ChatHeader>
          <div className="min-h-0 flex-1">
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
          </div>
        </div>
      ),
    )
    .with({ selection: null, signedIn: false, authFailed: true }, () => (
      <Placeholder
        icon={<LogInIcon />}
        title={t`계정 연결 상태를 불러오지 못했습니다`}
        description={t`앱 서버 연결을 확인한 뒤 다시 시도해 주십시오.`}
        action={
          <RetryButton
            onRetry={() =>
              Object.values(authQueries)
                .filter((query) => query.isError)
                .forEach((query) => void query.refetch())
            }
          />
        }
      />
    ))
    .with({ selection: null, signedIn: false }, () => (
      <Placeholder
        icon={<LogInIcon />}
        title={t`공급자를 연결해 주십시오`}
        description={t`왼쪽에서 OpenAI 호환 공급자를 설정하거나 구독 계정에 로그인해 주십시오.`}
        action={
          <Button variant="outline" onClick={() => setAccountsOpen(true)}>
            <UserIcon /> <Trans comment="Button that opens the account manager">계정 관리</Trans>
          </Button>
        }
      />
    ))
    .with({ selection: null }, () => (
      <Placeholder
        icon={<LogInIcon />}
        title={t`모델을 선택해 주십시오`}
        description={t`계정에서 쓸 수 있는 모델 중 하나를 골라 주십시오.`}
      />
    ))
    .with({ selection: P.nonNullable, selectedSignedIn: false }, ({ selection: selected }) => {
      const selectedProviderName = t(providerLabels[selected.provider]);
      return (
        <Placeholder
          icon={<LogInIcon />}
          title={
            selected.provider === "openai-compatible"
              ? t`호환 공급자를 설정해 주십시오`
              : t`선택한 공급자에 로그인해 주십시오`
          }
          description={t({
            message: `${selectedProviderName} 연결이 필요합니다.`,
            comment: "{selectedProviderName} is the model provider's name, such as ChatGPT",
          })}
        />
      );
    })
    .with({ projectId: null, projectsFailed: true }, () => (
      <Placeholder
        icon={<FolderIcon />}
        title={t`프로젝트 목록을 불러오지 못했습니다`}
        description={t`앱 서버 연결을 확인한 뒤 다시 시도해 주십시오.`}
        action={<RetryButton onRetry={() => void projectsQuery.refetch()} />}
      />
    ))
    .with({ projectId: null }, () => (
      <Placeholder
        icon={<FolderIcon />}
        title={t`프로젝트를 추가해 주십시오`}
        description={t`대화와 기억은 프로젝트 단위로 저장됩니다.`}
        action={
          <OpenFolderButton
            projects={projects}
            onAdd={addProject}
            onSelect={selectProject}
            onPickFolder={api.pickFolder}
            label={t({
              message: "프로젝트 추가",
              comment: "Button that adds a project from a folder",
            })}
          />
        }
      />
    ))
    .with({ sessionId: null }, () => (
      <Placeholder
        icon={<FolderIcon />}
        title={t`새 대화를 시작해 주십시오`}
        description={t`왼쪽에서 프로젝트 이름 옆의 + 버튼을 눌러 주십시오.`}
      />
    ))
    .exhaustive();

  return (
    <AppEventsProvider>
      <SessionEventsProvider projectId={projectId} sessionId={sessionId}>
        <SidebarProvider className="h-dvh" style={{ "--sidebar-width": "18rem" }}>
          <Sidebar>
            <SidebarHeader>
              <div className="flex items-center gap-1 pl-1">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">Context Agent</span>
                <ReportLink projectId={projectId} sessionId={sessionId} />
                <ThemeSelect />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t({
                    message: "설정",
                    comment: "Sidebar button that opens the settings",
                  })}
                  title={t({ message: "설정", comment: "Sidebar button that opens the settings" })}
                  onClick={openSettings}
                >
                  <SettingsIcon />
                </Button>
                <SidebarTrigger aria-label={t`사이드바 접기`} title={t`사이드바 접기 (⌘B)`} />
              </div>
            </SidebarHeader>
            <SidebarSeparator />
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
                    busy={modelMutation.isPending}
                    error={modelError}
                    onSelect={(model, effort) => void selectModel(model, effort)}
                  />
                ) : (
                  <div className="flex flex-col gap-2 px-4 py-3 text-xs text-muted-foreground">
                    <Trans comment="{providerName} is the model provider's name, such as ChatGPT">
                      {providerName} 계정을 연결하면 모델을 고를 수 있습니다.
                    </Trans>
                    <Button variant="outline" size="sm" onClick={() => setAccountsOpen(true)}>
                      <Trans comment="Button that opens account management to connect an account">
                        계정 연결
                      </Trans>
                    </Button>
                  </div>
                )}
              </AccountModelPanel>
            </div>
            <SidebarSeparator />
            <SidebarGroup>
              <SidebarMenu>
                <DecisionInbox
                  projects={projects.map((project) => ({ id: project.id, name: project.name }))}
                  holder={pageHolder()}
                  onOpenCard={(project, session, card) =>
                    void setLocation(
                      { ...leaveProject, project, session, card },
                      { history: "push" },
                    )
                  }
                />
              </SidebarMenu>
            </SidebarGroup>
            <SessionSection
              groups={listed}
              working={working}
              loading={sessionsLoading}
              failed={sessionsFailed}
              onRetry={retrySessions}
              projectId={projectId}
              sessionId={sessionId}
              archiveError={archiveError}
              onCreate={(target) => void createSession(target)}
              onArchive={archiveSession}
              onDelete={deleteSession}
              onRestore={restoreSession}
              header={
                <OpenFolderButton
                  projects={projects}
                  onAdd={addProject}
                  onSelect={selectProject}
                  onPickFolder={api.pickFolder}
                  label={t({
                    message: "프로젝트 추가",
                    comment: "Button that adds a project from a folder",
                  })}
                />
              }
              projectActions={(id) => {
                const project = projects.find((item) => item.id === id);
                return project === undefined ? null : (
                  <ProjectMenu
                    project={project}
                    onOpenBoard={() =>
                      void setLocation(
                        { ...leaveProject, project: id, boards: true },
                        { history: "push" },
                      )
                    }
                    onOpenSettings={() =>
                      openSettingsOverlay({ projectId: id, initialPage: "permission" })
                    }
                    onHidden={() => {
                      if (id !== projectId) return;
                      const left = projects.filter((item) => item.id !== id);
                      void setLocation({ ...leaveProject, project: left.at(0)?.id ?? null });
                    }}
                    onProblem={setArchiveError}
                  />
                );
              }}
            />
            <ArchivedProjects
              projects={hiddenProjects}
              onRestore={(restoredId) => void restoreProject(restoredId)}
            />

            <SidebarSeparator />
            <SidebarFooter>
              <ModelDownloadList className="px-2 pb-2" />
              <AccountSwitcher
                activeProvider={selection?.provider ?? provider}
                busy={switchMutation.isPending}
                error={switchError}
                onSwitch={(target) => void switchAccount(target)}
                onManage={() => setAccountsOpen(true)}
              />
            </SidebarFooter>
            <SidebarRail
              aria-label={t`사이드바 접기·펼치기`}
              title={t`사이드바 접기·펼치기 (⌘B)`}
            />
          </Sidebar>
          <Sheet open={accountsOpen} onOpenChange={setAccountsOpen}>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>
                  <Trans comment="Title of the account management sheet">계정 관리</Trans>
                </SheetTitle>
                <SheetDescription>
                  <Trans>
                    계정을 추가하고 계정마다 이름을 바꾸거나 로그아웃합니다. 쓸 계정은 사이드바 아래
                    계정 전환에서 고릅니다.
                  </Trans>
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                <AccountManager
                  auth={{ openai: auth.openai, anthropic: auth.anthropic }}
                  activeProvider={selection?.provider ?? provider}
                >
                  <CompatibleAccounts activeProvider={selection?.provider ?? provider} />
                </AccountManager>
              </div>
            </SheetContent>
          </Sheet>
          <SidebarInset className="min-w-0">
            <SidebarReopen />
            {main}
          </SidebarInset>
          {projectId && (boardsOpen === true || boardCardKeyParam !== null) && (
            <ProjectBoard
              projectId={projectId}
              holder={pageHolder()}
              peek={boardCardKeyParam === null ? null : parseBoardCardKey(boardCardKeyParam)}
              onPeek={(card) =>
                void setLocation({
                  boards: true,
                  boardCard: card === null ? null : boardCardKey(card),
                })
              }
              onOpenSession={(session) =>
                void setLocation(
                  { ...leaveProjectBoard, session, board: true, card: null },
                  { history: "push" },
                )
              }
              onClose={() => void setLocation({ boards: null, boardCard: null })}
            />
          )}
        </SidebarProvider>
      </SessionEventsProvider>
    </AppEventsProvider>
  );
}
