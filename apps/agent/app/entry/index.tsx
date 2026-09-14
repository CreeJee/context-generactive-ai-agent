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
  projectErrorMessage,
  type AuthState,
  type CodexModel,
  type ModelSelection,
  type Project,
  type Session,
} from "./api";
import { ChatPanel } from "./chat-panel";
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
  const [sessionId, setSessionId] = useState<string | null>(null);

  const refreshAuth = useCallback(() => api.auth().then(setAuth), []);

  useEffect(() => {
    void refreshAuth();
    void api.projects().then((list) => {
      setProjects(list);
      setProjectId((current) => current ?? list[0]?.id ?? null);
    });
  }, [refreshAuth]);

  // While the browser login is open, poll until codex reports the account.
  useEffect(() => {
    if (auth?.status !== "pending") return;
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

  useEffect(() => {
    if (!projectId) return;
    void api.sessions(projectId).then((list) => {
      setSessions(list);
      setSessionId(list[0]?.id ?? null);
    });
  }, [projectId]);

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

  const createSession = async () => {
    if (!projectId) return;
    const session = await api.createSession(projectId);
    setSessions((list) => [session, ...list]);
    setSessionId(session.id);
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
      <ChatPanel
        key={sessionId}
        sessionId={sessionId}
        imagesSupported={
          models
            .find((model) => model.model === selection.model)
            ?.inputModalities.includes("image") ?? false
        }
      />
    );

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="px-4 py-3 text-sm font-semibold">Context Agent</div>
        <Separator />
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
            void api
              .setPermissionMode(projectId, mode)
              .then((updated) =>
                setProjects((list) =>
                  list.map((project) => (project.id === updated.id ? updated : project)),
                ),
              );
          }}
        />
        <Separator />
        {projectId && (
          <SessionSection
            sessions={sessions}
            sessionId={sessionId}
            onSelect={setSessionId}
            onCreate={() => void createSession()}
          />
        )}
      </aside>
      <main className="min-w-0 flex-1">{main}</main>
    </div>
  );
}
