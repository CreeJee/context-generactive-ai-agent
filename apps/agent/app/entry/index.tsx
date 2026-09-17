import { FolderIcon, LogInIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Separator } from "~/components/ui/separator";
import {
  api,
  archiveErrorMessage,
  projectErrorMessage,
  type AuthState,
  type CodexModel,
  type ModelSelection,
  type Project,
  type Session,
} from "./api";
import { SessionView, type SlashSupport } from "./chat-panel";
import { ThemeSelect } from "./theme";
import { pageHolder } from "./session-lease";
import type { SlashContext } from "./slash-commands";
import { SettingsDialog } from "./settings-dialog";
import { AccountSection, ModelSection, ProjectSection, SessionSection } from "./sidebar";

const loginPollMs = 2000;

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
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [archived, setArchived] = useState<Session[]>([]);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [slashAgents, setSlashAgents] = useState<string[]>([]);
  const [slashSkills, setSlashSkills] = useState<SlashContext["skills"]>([]);

  const refreshAuth = useCallback(() => api.auth().then(setAuth), []);

  useEffect(() => {
    void refreshAuth();
    void api.projects().then((list) => {
      setProjects(list);
      // `context-agent <folder>` opens the page with ?project=<id>; keep the URL clean afterwards.
      const url = new URL(window.location.href);
      const launched = list.find((project) => project.id === url.searchParams.get("project"));
      if (url.searchParams.has("project")) {
        url.searchParams.delete("project");
        window.history.replaceState(null, "", url);
      }
      setProjectId((current) => launched?.id ?? current ?? list[0]?.id ?? null);
    });
  }, [refreshAuth]);

  // While the browser login is open or codex is still being fetched, poll until that changes.
  useEffect(() => {
    if (auth?.status !== "pending" && auth?.status !== "installing") return;
    const timer = setInterval(() => void refreshAuth(), loginPollMs);
    return () => clearInterval(timer);
  }, [auth?.status, refreshAuth]);

  const signedIn = auth?.status === "signed-in";
  useEffect(() => {
    if (!signedIn) return;
    void api.models().then(({ models, selected }) => {
      setModels(models);
      setSelection(selected);
    });
  }, [signedIn]);

  // What slash commands can offer in this project; settings may change it, so reload on close.
  useEffect(() => {
    if (!projectId || settingsOpen) return;
    void api.usableExternalAgents(projectId).then(setSlashAgents, () => setSlashAgents([]));
    void api.skills(projectId).then(
      (catalog) =>
        setSlashSkills(
          catalog.skills.map((skill) => ({ name: skill.name, description: skill.description })),
        ),
      () => setSlashSkills([]),
    );
  }, [projectId, settingsOpen]);

  useEffect(() => {
    if (!projectId) return;
    setArchiveError(null);
    void api.sessions(projectId).then((list) => {
      setSessions(list);
      setSessionId(list[0]?.id ?? null);
    });
    void api.archivedSessions(projectId).then(setArchived, () => setArchived([]));
  }, [projectId]);

  const untitled = sessions.some((session) => session.id === sessionId && session.title === null);
  useEffect(() => {
    if (!projectId || !untitled) return;
    let current = true;
    const timer = setInterval(() => {
      void api.sessions(projectId).then(
        (list) => {
          if (!current) return;
          const updated = list.find((session) => session.id === sessionId);
          if (!updated?.title) return;
          setSessions((existing) =>
            existing.map((session) =>
              session.id === updated.id ? { ...session, title: updated.title } : session,
            ),
          );
        },
        () => {},
      );
    }, 1000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [projectId, sessionId, untitled]);

  const archiveSession = async (id: string) => {
    try {
      const session = await api.setArchived(id, pageHolder(), true);
      setArchiveError(null);
      const remaining = sessions.filter((item) => item.id !== id);
      setSessions(remaining);
      setArchived((list) => [session, ...list]);
      if (sessionId === id) setSessionId(remaining[0]?.id ?? null);
    } catch (error) {
      setArchiveError(
        archiveErrorMessage(error instanceof Error ? error : new Error(String(error))),
      );
    }
  };

  const restoreSession = async (id: string) => {
    try {
      const session = await api.setArchived(id, pageHolder(), false);
      setArchiveError(null);
      setArchived((list) => list.filter((item) => item.id !== id));
      setSessions((list) =>
        [session, ...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    } catch (error) {
      setArchiveError(
        archiveErrorMessage(error instanceof Error ? error : new Error(String(error))),
      );
    }
  };

  const authAction = async (intent: "login" | "cancel" | "logout") => {
    const state = await api.authAction(intent);
    setAuth(state);
    if (state.status === "pending") window.open(state.authUrl, "_blank", "noopener");
  };

  const addProject = async (root: string) => {
    try {
      const project = await api.addProject(root);
      setProjects((list) => [...list, project]);
      setProjectId(project.id);
      return null;
    } catch (error) {
      return projectErrorMessage(error instanceof Error ? error : new Error(String(error)));
    }
  };

  // Imports register projects and add conversations in the background; show them once settings close.
  const changeSettingsOpen = (open: boolean) => {
    setSettingsOpen(open);
    if (open) return;
    void api.projects().then((list) => {
      setProjects(list);
      setProjectId((current) => current ?? list[0]?.id ?? null);
    });
    if (projectId)
      void api.sessions(projectId).then((list) => {
        setSessions(list);
        setSessionId((current) => current ?? list[0]?.id ?? null);
      });
  };

  const replaceProject = (updated: Project) =>
    setProjects((list) => list.map((project) => (project.id === updated.id ? updated : project)));

  const createSession = async (agent?: string) => {
    if (!projectId) return;
    const session = await api.createSession(projectId, agent);
    setSessions((list) => [session, ...list]);
    setSessionId(session.id);
  };

  const slash: SlashSupport = {
    context: {
      agents: slashAgents,
      models: models.map((model) => ({ id: model.model, label: model.displayName })),
      skills: slashSkills,
    },
    run: async (command) => {
      switch (command.kind) {
        case "new":
          return await createSession();
        case "agent":
          return await createSession(command.agent);
        case "settings":
          return setSettingsOpen(true);
        case "mode":
          if (projectId) replaceProject(await api.setPermissionMode(projectId, command.mode));
          return;
        case "model":
          setSelection(await api.selectModel(command.model));
          return;
      }
    },
  };

  let main: React.ReactNode;
  if (!signedIn)
    main = (
      <Placeholder
        icon={<LogInIcon />}
        title="ChatGPT에 로그인하세요"
        description="왼쪽에서 로그인하면 대화를 시작할 수 있어요."
      />
    );
  else if (!selection)
    main = (
      <Placeholder
        icon={<LogInIcon />}
        title="모델을 선택하세요"
        description="계정에서 쓸 수 있는 모델 중 하나를 고르세요."
      />
    );
  else if (!projectId)
    main = (
      <Placeholder
        icon={<FolderIcon />}
        title="프로젝트를 추가하세요"
        description="대화와 기억은 프로젝트 단위로 저장돼요."
      />
    );
  else if (!sessionId)
    main = (
      <Placeholder
        icon={<FolderIcon />}
        title="새 대화를 시작하세요"
        description="왼쪽의 새 대화 버튼을 누르세요."
      />
    );
  else
    main = (
      <SessionView
        key={sessionId}
        sessionId={sessionId}
        slash={slash}
        imagesSupported={
          sessions.find((session) => session.id === sessionId)?.agent == null &&
          (models
            .find((model) => model.model === selection.model)
            ?.inputModalities.includes("image") ??
            false)
        }
      />
    );

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between py-2 pr-2 pl-4">
          <span className="text-sm font-semibold">Context Agent</span>
          <SettingsDialog
            project={projects.find((project) => project.id === projectId) ?? null}
            open={settingsOpen}
            onOpenChange={changeSettingsOpen}
          />
        </div>
        <Separator />
        <div className="px-4 py-2">
          <ThemeSelect />
        </div>
        <AccountSection auth={auth} onAction={(intent) => void authAction(intent)} />
        {signedIn && (
          <ModelSection
            models={models}
            selection={selection}
            onSelect={(model, effort) => void api.selectModel(model, effort).then(setSelection)}
          />
        )}
        <Separator />
        <ProjectSection
          projects={projects}
          projectId={projectId}
          onSelect={setProjectId}
          onAdd={addProject}
          onPermissionMode={(mode) => {
            if (!projectId) return;
            void api.setPermissionMode(projectId, mode).then(replaceProject);
          }}
          onCrossRecall={(allowed) => {
            if (!projectId) return;
            void api.setCrossRecallExcluded(projectId, !allowed).then(replaceProject);
          }}
          onHide={(hiddenId) => {
            void api.hideProject(hiddenId).then(() => {
              setProjects((list) => {
                const left = list.filter((project) => project.id !== hiddenId);
                setProjectId(left.at(0)?.id ?? null);
                return left;
              });
            });
          }}
        />
        <Separator />
        {projectId && (
          <SessionSection
            sessions={sessions}
            archived={archived}
            sessionId={sessionId}
            archiveError={archiveError}
            onSelect={setSessionId}
            onCreate={(agent) => void createSession(agent)}
            onArchive={(id) => void archiveSession(id)}
            onRestore={(id) => void restoreSession(id)}
            loadAgents={() => api.usableExternalAgents(projectId)}
          />
        )}
      </aside>
      <main className="min-w-0 flex-1">{main}</main>
    </div>
  );
}
