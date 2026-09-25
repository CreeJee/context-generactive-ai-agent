import { useAuthQuery, useModelsQuery, useProjectsQuery } from "./queries/global";
import {
  useAddProjectMutation,
  useAuthActionMutation,
  useSelectModelMutation,
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
import { WorkTracePanel } from "./chat/work-trace-panel";

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
  const auth = { openai: openAIAuth.data ?? null, anthropic: anthropicAuth.data ?? null };
  const [provider, setProvider] = useState<ProviderId>("openai");
  const openAIModels = useModelsQuery("openai", auth.openai?.status === "signed-in");
  const anthropicModels = useModelsQuery("anthropic", auth.anthropic?.status === "signed-in");
  const models = (provider === "openai" ? openAIModels.data : anthropicModels.data)?.models ?? [];
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const projectsQuery = useProjectsQuery();
  const projects = projectsQuery.data ?? [];
  const [{ project: projectId, session: sessionId }, setLocation] = useQueryStates(locationParsers);
  const authMutation = useAuthActionMutation(provider);
  const addProjectMutation = useAddProjectMutation();
  const modelMutation = useSelectModelMutation(provider);
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
  const slashAgents = agentsQuery.data ? usableAgents(agentsQuery.data) : [];
  const slashSkills =
    skillsQuery.data?.skills.map(({ name, description }) => ({ name, description })) ?? [];

  useEffect(() => {
    if (!projectsQuery.data) return;
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
      provider === "openai"
        ? (openAIModels.data?.selected ?? anthropicModels.data?.selected)
        : (anthropicModels.data?.selected ?? openAIModels.data?.selected);
    if (selected) {
      setSelection(selected);
      setProvider(selected.provider);
    }
  }, [openAIModels.data?.selected, anthropicModels.data?.selected]);

  useEffect(() => {
    if (!projectId || !sessionsQuery.data) return;
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

  const archiveSession = async (id: string) => {
    if (!projectId) return;
    try {
      const result = await lifecycleMutation.mutateAsync({ kind: "archive", sessionId: id });
      if (result.status !== "completed") return refreshPendingLifecycle(result.status);
      setArchiveError(null);
      const remaining = sessions.filter((item) => item.id !== id);
      if (sessionId === id) void setLocation({ session: remaining[0]?.id ?? null });
    } catch (error) {
      setArchiveError(
        archiveErrorMessage(error instanceof Error ? error : new Error(String(error))),
      );
    }
  };

  const deleteSession = async (id: string) => {
    if (!projectId) return;
    try {
      const result = await lifecycleMutation.mutateAsync({ kind: "delete", sessionId: id });
      if (result.status !== "completed") return refreshPendingLifecycle(result.status);
      setArchiveError(null);
      const remaining = sessions.filter((item) => item.id !== id);
      if (sessionId === id) void setLocation({ session: remaining[0]?.id ?? null });
    } catch (error) {
      setArchiveError(
        archiveErrorMessage(error instanceof Error ? error : new Error(String(error))),
      );
    }
  };

  const restoreSession = async (id: string) => {
    if (!projectId) return;
    try {
      const result = await lifecycleMutation.mutateAsync({ kind: "restore", sessionId: id });
      if (result.status !== "completed") return refreshPendingLifecycle(result.status);
      setArchiveError(null);
    } catch (error) {
      setArchiveError(
        archiveErrorMessage(error instanceof Error ? error : new Error(String(error))),
      );
    }
  };

  const authAction = async (intent: "login" | "cancel" | "logout") => {
    const state = await authMutation.mutateAsync(intent);
    if (state.status === "pending") window.open(state.authUrl, "_blank", "noopener");
  };

  const addProject = async (root: string) => {
    try {
      const project = await addProjectMutation.mutateAsync(root);
      void setLocation({ project: project.id, session: null }, { history: "push" });
      return null;
    } catch (error) {
      return projectErrorMessage(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const openSettings = () =>
    openSettingsOverlay(projects.find((item) => item.id === projectId) ?? null);

  const selectModel = async (model: string, effort?: string) => {
    const selected = await modelMutation.mutateAsync({ model, effort });
    setSelection(selected);
  };

  const createSession = async (agent?: string) => {
    if (!projectId) return;
    const session = await createSessionMutation.mutateAsync(agent);
    void setLocation({ session: session.id }, { history: "push" });
  };

  const slash: SlashSupport = {
    context: {
      agents: slashAgents,
      models: models.map((model) => ({ id: model.id, label: model.displayName })),
      skills: slashSkills,
    },
    run: async (command) => {
      switch (command.kind) {
        case "new":
          return await createSession();
        case "agent":
          return await createSession(command.agent);
        case "settings":
          return openSettings();
        case "mode":
          if (projectId) await permissionMutation.mutateAsync(command.mode);
          return;
        case "model":
          await selectModel(command.model);
          return;
      }
    },
  };

  const main = match({ selection, signedIn, selectedSignedIn, projectId, sessionId })
    .with({ selection: null, signedIn: false }, () => (
      <Placeholder
        icon={<LogInIcon />}
        title="구독 계정에 로그인하세요"
        description="왼쪽에서 ChatGPT 또는 Claude에 연결하면 대화를 시작할 수 있어요."
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
        title="선택한 공급자에 로그인하세요"
        description={`${selected.provider === "openai" ? "ChatGPT" : "Claude"} 연결이 필요해요.`}
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
    .with(
      { selection: P.nonNullable, sessionId: P.string },
      ({ selection: selected, sessionId: id }) => (
        <SessionView
          key={id}
          sessionId={id}
          slash={slash}
          imagesSupported={
            sessions.find((session) => session.id === id)?.agent == null &&
            ((
              (selected.provider === "openai" ? openAIModels.data : anthropicModels.data)?.models ??
              []
            )
              .find((model) => model.id === selected.model)
              ?.capabilities.inputModalities.includes("image") ??
              false)
          }
        />
      ),
    )
    .exhaustive();

  return (
    <AppEventsProvider>
      <SessionEventsProvider projectId={projectId} sessionId={sessionId}>
        <div className="flex h-dvh bg-background text-foreground">
          <aside className="flex min-h-0 w-72 shrink-0 flex-col overflow-hidden border-r">
            <div className="flex items-center justify-between py-2 pr-2 pl-4">
              <span className="text-sm font-semibold">Context Agent</span>
              <Button variant="ghost" size="icon-sm" aria-label="설정" onClick={openSettings}>
                <SettingsIcon />
              </Button>
            </div>
            <Separator />
            <div className="min-h-0 shrink overflow-y-auto overscroll-contain">
              <div className="px-4 py-2">
                <ThemeSelect />
              </div>
              <AccountSection
                auth={auth[provider]}
                provider={provider}
                onProviderChange={setProvider}
                onAction={(intent) => void authAction(intent)}
              />
              {signedIn && (
                <ModelSection
                  models={models}
                  selection={selection?.provider === provider ? selection : null}
                  onSelect={(model, effort) => void selectModel(model, effort)}
                />
              )}
              <Separator />
              <ProjectSection
                projects={projects}
                projectId={projectId}
                onSelect={selectProject}
                onAdd={addProject}
                onPermissionMode={(mode) => {
                  if (!projectId) return;
                  void permissionMutation.mutateAsync(mode);
                }}
                onCrossRecall={(allowed) => {
                  if (!projectId) return;
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
          </aside>
          <main className="min-w-0 flex-1">{main}</main>
          {projectId && <WorkTracePanel projectId={projectId} sessionId={sessionId} />}
        </div>
      </SessionEventsProvider>
    </AppEventsProvider>
  );
}
