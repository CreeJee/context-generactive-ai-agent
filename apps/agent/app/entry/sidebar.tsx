import { BotIcon, ChevronDownIcon, FolderPlusIcon, LogOutIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
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
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import type {
  AuthState,
  CodexModel,
  ModelSelection,
  PermissionMode,
  Project,
  Session,
} from "./api";

const unavailableReasons = {
  not_installed: "앱에 이 기기용 codex가 들어 있지 않아요. 이 기기에 맞는 앱을 다시 설치하세요.",
  install_failed:
    "ChatGPT 연결에 필요한 codex를 받지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도하세요.",
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
      {auth.status === "installing" && (
        <div className="flex items-center gap-2 text-xs">
          <Spinner /> ChatGPT 연결에 필요한 codex를 받는 중이에요(처음 한 번)
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

const permissionModes = [
  { value: "ask", label: "매번 묻기" },
  { value: "auto", label: "자동 판단 (auto)" },
] satisfies ReadonlyArray<{ value: PermissionMode; label: string }>;

const permissionHints = new Map<PermissionMode, string>([
  ["ask", "셸 실행과 프로젝트 밖 쓰기는 호출마다 승인을 받아요."],
  [
    "auto",
    "분류 모델이 호출마다 판단해서 안전하면 바로 실행하고, 애매하면 묻고, 위험하면 막아요. 판단할 때마다 모델 호출이 추가돼요.",
  ],
]);

export function ProjectSection({
  projects,
  projectId,
  onSelect,
  onAdd,
  onPermissionMode,
  onCrossRecall,
}: {
  projects: Project[];
  projectId: string | null;
  onSelect: (projectId: string) => void;
  onAdd: (root: string) => Promise<string | null>;
  onPermissionMode: (mode: PermissionMode) => void;
  /** Whether conversations in other projects may recall this project's memory (R08). */
  onCrossRecall: (allowed: boolean) => void;
}) {
  const [root, setRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const current = projects.find((project) => project.id === projectId);

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
      {current && (
        <div className="flex flex-col gap-1.5">
          <Select
            value={current.permissionMode}
            items={permissionModes}
            onValueChange={(value) => {
              const mode = permissionModes.find((option) => option.value === value);
              if (mode) onPermissionMode(mode.value);
            }}
          >
            <SelectTrigger className="w-full" size="sm" aria-label="권한 모드">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {permissionModes.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {permissionHints.get(current.permissionMode)}
          </p>
          <label className="mt-1.5 flex cursor-pointer items-start justify-between gap-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-xs font-medium">다른 프로젝트에서 이 기억 찾기</span>
              <span className="text-xs text-muted-foreground">
                {current.crossRecallExcluded
                  ? "다른 프로젝트 대화에서는 이 프로젝트의 기억을 찾지 않아요."
                  : "다른 프로젝트 대화에서도 찾아서 출처 프로젝트와 함께 보여줘요."}
              </span>
            </span>
            <Switch
              className="mt-0.5"
              checked={!current.crossRecallExcluded}
              onCheckedChange={(checked) => onCrossRecall(checked)}
            />
          </label>
        </div>
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
  loadAgents,
}: {
  sessions: Session[];
  sessionId: string | null;
  onSelect: (sessionId: string) => void;
  /** Without an agent the conversation uses the app's model. */
  onCreate: (agent?: string) => void;
  /** Trusted external agents a conversation can talk to directly. */
  loadAgents: () => Promise<string[]>;
}) {
  const [agents, setAgents] = useState<string[]>([]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h2 className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
          대화
        </h2>
        <div className="flex items-center">
          <Button variant="ghost" size="sm" onClick={() => onCreate()}>
            <PlusIcon /> 새 대화
          </Button>
          <DropdownMenu
            onOpenChange={(open) => {
              if (open) void loadAgents().then(setAgents, () => setAgents([]));
            }}
          >
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="대화 상대 고르기" />}
            >
              <ChevronDownIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>새 대화 상대</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => onCreate()}>이 앱의 모델</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>외부 에이전트와 직접</DropdownMenuLabel>
                {agents.length === 0 ? (
                  <DropdownMenuItem disabled>설정에서 신뢰한 에이전트가 없어요</DropdownMenuItem>
                ) : (
                  agents.map((agent) => (
                    <DropdownMenuItem key={agent} onClick={() => onCreate(agent)}>
                      <BotIcon /> {agent}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
                session.id === sessionId && "bg-muted font-medium",
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {session.title ?? dateFormat.format(new Date(session.createdAt))}
              </span>
              {session.agent && (
                <Badge variant="outline" className="shrink-0">
                  <BotIcon /> {session.agent}
                </Badge>
              )}
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
