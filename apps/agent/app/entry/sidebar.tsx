import { FolderPlusIcon, LogOutIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import type { AuthState, CodexModel, ModelSelection, Project, Session } from "./api";

const unavailableReasons = {
  not_installed: "codex CLI를 찾을 수 없어요. codex를 설치한 뒤 다시 시도하세요.",
  spawn_failed: "codex를 시작하지 못했어요.",
  exited: "codex 프로세스가 종료됐어요. 다시 시도하세요.",
} satisfies Record<Extract<AuthState, { status: "unavailable" }>["reason"], string>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-4 py-3">
      <h2 className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function AccountSection({
  auth,
  onAction,
}: {
  auth: AuthState | null;
  onAction: (intent: "login" | "cancel" | "logout") => void;
}) {
  if (!auth)
    return (
      <Section title="ChatGPT">
        <Spinner />
      </Section>
    );
  return (
    <Section title="ChatGPT">
      {auth.status === "signed-in" && (
        <div className="flex items-center gap-2">
          <Badge variant="secondary">연결됨</Badge>
          {auth.planType && <span className="text-xs text-muted-foreground">{auth.planType}</span>}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={() => onAction("logout")}
            aria-label="로그아웃"
          >
            <LogOutIcon />
          </Button>
        </div>
      )}
      {auth.status === "pending" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs">
            <Spinner /> 브라우저에서 로그인을 완료하세요
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(auth.authUrl, "_blank", "noopener")}
            >
              로그인 창 다시 열기
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction("cancel")}>
              취소
            </Button>
          </div>
        </div>
      )}
      {(auth.status === "signed-out" ||
        auth.status === "error" ||
        auth.status === "unavailable") && (
        <div className="flex flex-col gap-2">
          {auth.status === "error" && (
            <Alert variant="destructive">
              <AlertDescription>{auth.message}</AlertDescription>
            </Alert>
          )}
          {auth.status === "unavailable" && (
            <Alert variant="destructive">
              <AlertDescription>{unavailableReasons[auth.reason]}</AlertDescription>
            </Alert>
          )}
          <Button onClick={() => onAction("login")}>ChatGPT로 로그인</Button>
        </div>
      )}
    </Section>
  );
}

export function ModelSection({
  models,
  selection,
  onSelect,
}: {
  models: CodexModel[];
  selection: ModelSelection | null;
  onSelect: (model: string, reasoningEffort?: string) => void;
}) {
  const current = models.find((model) => model.model === selection?.model);
  return (
    <Section title="모델">
      <Select
        value={selection?.model ?? null}
        items={models.map((model) => ({ value: model.model, label: model.displayName }))}
        onValueChange={(value) => value && onSelect(value)}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="모델을 선택하세요" />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={model.model} value={model.model}>
              {model.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {current && selection && (
        <Select
          value={selection.reasoningEffort}
          items={current.supportedReasoningEfforts.map((option) => ({
            value: option.reasoningEffort,
            label: `추론 ${option.reasoningEffort}`,
          }))}
          onValueChange={(value) => value && onSelect(current.model, value)}
        >
          <SelectTrigger className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {current.supportedReasoningEfforts.map((option) => (
              <SelectItem key={option.reasoningEffort} value={option.reasoningEffort}>
                추론 {option.reasoningEffort}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {!selection && (
        <p className="text-xs text-muted-foreground">
          선택한 모델이 없으면 대화를 시작할 수 없어요. 다른 모델로 자동 대체하지 않아요.
        </p>
      )}
    </Section>
  );
}

export function ProjectSection({
  projects,
  projectId,
  onSelect,
  onAdd,
}: {
  projects: Project[];
  projectId: string | null;
  onSelect: (projectId: string) => void;
  onAdd: (root: string) => Promise<string | null>;
}) {
  const [root, setRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <Section title="프로젝트">
      {projects.length > 0 && (
        <Select
          value={projectId}
          items={projects.map((project) => ({ value: project.id, label: project.name }))}
          onValueChange={(value) => value && onSelect(value)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="프로젝트를 선택하세요" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!root.trim()) return;
          setAdding(true);
          const failure = await onAdd(root.trim());
          setAdding(false);
          setError(failure);
          if (!failure) setRoot("");
        }}
      >
        <Input
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          placeholder="/절대/경로/프로젝트"
          aria-label="프로젝트 경로"
        />
        <Button
          type="submit"
          variant="outline"
          size="icon"
          disabled={adding || !root.trim()}
          aria-label="프로젝트 추가"
        >
          {adding ? <Spinner /> : <FolderPlusIcon />}
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Section>
  );
}

const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function SessionSection({
  sessions,
  sessionId,
  onSelect,
  onCreate,
}: {
  sessions: Session[];
  sessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h2 className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
          대화
        </h2>
        <Button variant="ghost" size="sm" onClick={onCreate}>
          <PlusIcon /> 새 대화
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              className={cn(
                "rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
                session.id === sessionId && "bg-muted font-medium",
              )}
            >
              {session.title ?? dateFormat.format(new Date(session.createdAt))}
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">아직 대화가 없어요.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export { Separator };
