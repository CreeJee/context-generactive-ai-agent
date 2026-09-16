import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeOffIcon,
  FolderPlusIcon,
  LogOutIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
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
    "ChatGPT 연결에 필요한 codex를 받거나 설치하지 못했어요. 잠시 뒤 다시 시도하세요. 계속되면 앱을 실행한 창에 나온 오류를 확인하세요.",
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

const permissionHints = {
  ask: "셸 실행과 프로젝트 밖 쓰기는 호출마다 승인을 받아요.",
  auto: "분류 모델이 호출마다 판단해서 안전하면 바로 실행하고, 애매하면 묻고, 위험하면 막아요. 판단할 때마다 모델 호출이 추가돼요.",
} satisfies Record<PermissionMode, string>;

export function ProjectSection({
  projects,
  projectId,
  onSelect,
  onAdd,
  onPermissionMode,
  onCrossRecall,
  onHide,
}: {
  projects: Project[];
  projectId: string | null;
  onSelect: (projectId: string) => void;
  onAdd: (root: string) => Promise<string | null>;
  onPermissionMode: (mode: PermissionMode) => void;
  /** Whether conversations in other projects may recall this project's memory (R08). */
  onCrossRecall: (allowed: boolean) => void;
  /** Takes the project out of this list; its conversations and memory stay. */
  onHide: (projectId: string) => void;
}) {
  const current = projects.find((project) => project.id === projectId);

  return (
    <Section title="프로젝트">
      <div className="flex items-center gap-2">
        {projects.length > 0 ? (
          <Select
            value={projectId}
            items={projects.map((project) => ({ value: project.id, label: project.name }))}
            onValueChange={(value) => value && onSelect(value)}
          >
            <SelectTrigger className="min-w-0 flex-1">
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
        ) : (
          <p className="flex-1 text-xs text-muted-foreground">등록된 프로젝트가 없어요.</p>
        )}
        <AddProjectDialog onAdd={onAdd} />
      </div>
      {current && (
        <div className="mt-1 flex flex-col gap-1.5 border-l-2 pl-2.5">
          <span className="text-[0.6875rem] font-medium text-muted-foreground">
            {current.name} 설정
          </span>
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
          <p className="text-xs text-muted-foreground">{permissionHints[current.permissionMode]}</p>
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
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 self-start text-muted-foreground"
            title="목록에서 빼기(대화와 기억은 그대로)"
            onClick={() => onHide(current.id)}
          >
            <EyeOffIcon /> 목록에서 빼기
          </Button>
          <p className="text-xs text-muted-foreground">
            대화·기억·검색은 그대로 남아요. 같은 폴더를 다시 추가하면 돌아와요.
          </p>
        </div>
      )}
    </Section>
  );
}

/** Registering a folder widens what the file tools may touch, so it lives in its own dialog. */
function AddProjectDialog({ onAdd }: { onAdd: (root: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="icon" aria-label="프로젝트 추가" title="프로젝트 추가" />
        }
      >
        <FolderPlusIcon />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>프로젝트 추가</DialogTitle>
          <DialogDescription>
            폴더의 절대 경로를 입력하세요. 등록한 폴더 안의 파일은 에이전트가 읽고 고칠 수 있어요.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!root.trim()) return;
            setAdding(true);
            const failure = await onAdd(root.trim());
            setAdding(false);
            setError(failure);
            if (failure) return;
            setRoot("");
            setOpen(false);
          }}
        >
          <Field>
            <FieldLabel htmlFor="project-root">폴더 경로</FieldLabel>
            <Input
              id="project-root"
              value={root}
              onChange={(event) => setRoot(event.target.value)}
              placeholder="/Users/me/work/my-project"
              autoFocus
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>취소</DialogClose>
            <Button type="submit" disabled={adding || !root.trim()}>
              {adding && <Spinner />} 추가
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const sessionLabel = (session: Session) =>
  session.title ?? dateFormat.format(new Date(session.createdAt));

export function SessionSection({
  sessions,
  archived,
  sessionId,
  archiveError,
  onSelect,
  onCreate,
  onArchive,
  onRestore,
  loadAgents,
}: {
  sessions: Session[];
  archived: Session[];
  sessionId: string | null;
  /** Why the last archive or restore was refused, if it was. */
  archiveError: string | null;
  onSelect: (sessionId: string) => void;
  /** Without an agent the conversation uses the app's model. */
  onCreate: (agent?: string) => void;
  onArchive: (sessionId: string) => void;
  onRestore: (sessionId: string) => void;
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
      {archiveError && (
        <Alert variant="destructive" className="mx-2 mb-2 w-auto">
          <AlertDescription>{archiveError}</AlertDescription>
        </Alert>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                "group flex items-center rounded-md hover:bg-muted",
                session.id === sessionId && "bg-muted font-medium",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                {session.agent && (
                  <Badge variant="outline" className="shrink-0">
                    <BotIcon /> {session.agent}
                  </Badge>
                )}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onArchive(session.id)}
                aria-label="대화 보관"
                title="보관(목록에서 빼고 기억은 유지)"
              >
                <ArchiveIcon />
              </Button>
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">아직 대화가 없어요.</p>
          )}
          {archived.length > 0 && (
            <Collapsible className="mt-2">
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="group w-full justify-start text-xs text-muted-foreground"
                  />
                }
              >
                <ChevronRightIcon className="transition-transform group-data-[panel-open]:rotate-90" />
                <ArchiveIcon /> 보관함
                <Badge variant="secondary" className="ml-auto" aria-label={`${archived.length}개`}>
                  {archived.length}
                </Badge>
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-0.5">
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  목록에서만 뺀 대화예요. 기억 검색에는 계속 나와요.
                </p>
                {archived.map((session) => (
                  <div
                    key={session.id}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                    <Button variant="ghost" size="xs" onClick={() => onRestore(session.id)}>
                      <ArchiveRestoreIcon /> 복원
                    </Button>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export { Separator };
