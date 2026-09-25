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
  Trash2Icon,
} from "lucide-react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
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
import { dayAndTime } from "~/lib/dates";
import { cn } from "~/lib/utils";
import type {
  ProviderModel,
  ModelSelection,
  PermissionMode,
  ProviderAuthState,
  ProviderId,
  Project,
  Session,
} from "../api";

const providerLabels = { openai: "ChatGPT", anthropic: "Claude" } satisfies Record<
  ProviderId,
  string
>;
const providerOptions = [
  { value: "openai", label: providerLabels.openai },
  { value: "anthropic", label: providerLabels.anthropic },
] satisfies ReadonlyArray<{ value: ProviderId; label: string }>;
const isProviderId = (value: string): value is ProviderId =>
  value === "openai" || value === "anthropic";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-4 py-3">
      <h2 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function AccountSection({
  auth,
  provider,
  onProviderChange,
  onAction,
}: {
  auth: ProviderAuthState | null;
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  onAction: (intent: "login" | "cancel" | "logout") => void;
}) {
  return (
    <Section title="구독 계정">
      <Select
        value={provider}
        items={providerOptions}
        onValueChange={(value) => value && isProviderId(value) && onProviderChange(value)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {providerOptions.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!auth && <Spinner />}
      {auth?.status === "signed-in" && (
        <div className="flex items-center gap-2">
          <Badge variant="secondary">연결됨</Badge>
          {auth.planType && <span className="text-xs text-muted-foreground">{auth.planType}</span>}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={() => onAction("logout")}
            aria-label="연결 해제"
          >
            <LogOutIcon />
          </Button>
        </div>
      )}
      {auth?.status === "pending" && (
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
      {(auth?.status === "signed-out" || auth?.status === "error") && (
        <div className="flex flex-col gap-2">
          {auth.status === "error" && (
            <Alert variant="destructive" className="min-w-0">
              <AlertDescription className="min-w-0 break-words">
                {auth.message}
                {(auth.code || auth.httpStatus || auth.providerCode) && (
                  <details className="mt-2 text-2xs">
                    <summary className="cursor-pointer">진단 정보</summary>
                    <dl className="mt-1 space-y-0.5 break-all font-mono">
                      {auth.code && <div>code: {auth.code}</div>}
                      {auth.operation && <div>operation: {auth.operation}</div>}
                      {auth.httpStatus && <div>HTTP: {auth.httpStatus}</div>}
                      {auth.providerCode && <div>provider code: {auth.providerCode}</div>}
                      {auth.credentialStage && <div>credential stage: {auth.credentialStage}</div>}
                      {auth.transportCode && <div>transport code: {auth.transportCode}</div>}
                      {auth.proxyRoute && <div>proxy route: {auth.proxyRoute}</div>}
                    </dl>
                  </details>
                )}
              </AlertDescription>
            </Alert>
          )}
          <Button onClick={() => onAction("login")}>{providerLabels[provider]}로 로그인</Button>
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
  models: ProviderModel[];
  selection: ModelSelection | null;
  onSelect: (model: string, reasoningEffort?: string) => void;
}) {
  const current = models.find((model) => model.id === selection?.model);
  return (
    <Section title="모델">
      <Select
        value={selection?.model ?? null}
        items={models.map((model) => ({ value: model.id, label: model.displayName }))}
        onValueChange={(value) => value && onSelect(value)}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="모델을 선택하세요" />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {model.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {current && selection && (
        <Select
          value={selection.reasoningEffort}
          items={current.supportedReasoningEfforts.map((effort) => ({
            value: effort,
            label: `추론 ${effort}`,
          }))}
          onValueChange={(value) => value && onSelect(current.id, value)}
        >
          <SelectTrigger className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {current.supportedReasoningEfforts.map((effort) => (
              <SelectItem key={effort} value={effort}>
                추론 {effort}
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
  { value: "full", label: "전체 권한 (full)" },
] satisfies ReadonlyArray<{ value: PermissionMode; label: string }>;

const permissionHints = {
  ask: "셸 실행과 프로젝트 밖 쓰기는 호출마다 승인을 받아요.",
  auto: "분류 모델이 호출마다 판단해서 안전하면 바로 실행하고, 애매하면 묻고, 위험하면 막아요. 판단할 때마다 모델 호출이 추가돼요.",
  full: "호출별 승인 없이 실행해요. 프로젝트 경로, 자격 증명, .git 보호 규칙은 계속 적용돼요.",
} satisfies Record<PermissionMode, string>;

const projectSectionOpenAtom = atomWithStorage("context-agent-project-section-open", true);

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
  const [open, setOpen] = useAtom(projectSectionOpenAtom);

  return (
    <section className="px-4 py-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
          프로젝트
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-2">
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
              <span className="text-2xs font-medium text-muted-foreground">
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
              <p className="text-xs text-muted-foreground">
                {permissionHints[current.permissionMode]}
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
              <Button
                variant="ghost-muted"
                size="sm"
                className="mt-1 self-start"
                title="목록에서 빼기(대화와 기억은 그대로)"
                onClick={() => onHide(current.id)}
              >
                <EyeOffIcon /> 목록에서 빼기
              </Button>
              <p className="text-xs text-muted-foreground">
                대화와 기억, 검색은 그대로 남아요. 같은 폴더를 다시 추가하면 돌아와요.
              </p>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
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

const sessionLabel = (session: Session) => session.title ?? dayAndTime(session.createdAt);

export function SessionSection({
  sessions,
  archived,
  projectId,
  sessionId,
  archiveError,
  onCreate,
  onArchive,
  onDelete,
  onRestore,
  agents,
}: {
  sessions: Session[];
  archived: Session[];
  projectId: string;
  sessionId: string | null;
  /** Why the last archive or restore was refused, if it was. */
  archiveError: string | null;
  /** Without an agent the conversation uses the app's model. */
  onCreate: (agent?: string) => void;
  onArchive: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRestore: (sessionId: string) => void;
  /** Trusted external agents a conversation can talk to directly. */
  agents: readonly string[];
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h2 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">대화</h2>
        <div className="flex items-center">
          <Button variant="ghost" size="sm" onClick={() => onCreate()}>
            <PlusIcon /> 새 대화
          </Button>
          <DropdownMenu>
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
              <a
                href={`/?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(session.id)}`}
                aria-current={session.id === sessionId ? "page" : undefined}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                {session.agent && (
                  <Badge variant="outline" className="shrink-0">
                    <BotIcon /> {session.agent}
                  </Badge>
                )}
              </a>
              {/* The row shows its action on hover, or while the action has keyboard focus. */}
              <div className="mr-1 flex opacity-0 group-hover:opacity-100 has-focus-visible:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onArchive(session.id)}
                  aria-label="대화 보관"
                  title="보관하기(실행 중이면 안전하게 중단하고 기억은 남겨요)"
                >
                  <ArchiveIcon />
                </Button>
                <Button
                  variant="destructive"
                  size="icon-xs"
                  onClick={() => {
                    if (
                      window.confirm(
                        "대화 원본을 삭제할까요? 채택된 project memory와 Work Trace provenance는 유지돼요.",
                      )
                    )
                      onDelete(session.id);
                  }}
                  aria-label="대화 삭제"
                  title="원본 삭제(채택된 project 지식과 provenance는 유지)"
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">아직 대화가 없어요.</p>
          )}
          {archived.length > 0 && (
            <Collapsible className="mt-2">
              <CollapsibleTrigger
                render={
                  <Button variant="ghost-muted" size="sm" className="group w-full justify-start" />
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
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => {
                        if (
                          window.confirm(
                            "보관된 대화 원본을 삭제할까요? 채택된 project memory와 provenance는 유지돼요.",
                          )
                        )
                          onDelete(session.id);
                      }}
                    >
                      <Trash2Icon /> 삭제
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
