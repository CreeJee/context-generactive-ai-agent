import { Data, Effect } from "effect";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { isTruthy } from "../../truthy.ts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeOffIcon,
  FolderPlusIcon,
  GitBranchIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useState } from "react";
import { Link } from "react-router";
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
import type { ProviderModel, ModelSelection, PermissionMode, Project, Session } from "../api";
import { DataList, DataListItem } from "~/components/ui/data-list";
import { SidebarDisclosureTrigger } from "./sidebar-disclosure-trigger";
import { effortChoices } from "./providers";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="px-3 py-2 not-last:border-b">
      <DataList className="grid-cols-[3.5rem_minmax(0,1fr)]">{children}</DataList>
    </section>
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
  const efforts =
    current !== undefined && selection !== null ? effortChoices(selection, current) : [];
  return (
    <Section title="모델">
      <DataListItem term="모델">
        <Select
          value={selection?.model ?? null}
          items={models.map((model) => ({ value: model.id, label: model.displayName }))}
          onValueChange={(value) => value && onSelect(value)}
        >
          <SelectTrigger className="w-full" size="sm" aria-label="모델">
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
      </DataListItem>
      {current && selection && efforts.length > 0 && (
        <DataListItem term="추론">
          <Select
            value={selection.reasoningEffort}
            items={efforts.map(({ id, label }) => ({ value: id, label }))}
            onValueChange={(value) => value && onSelect(current.id, value)}
          >
            <SelectTrigger className="w-full" size="sm" aria-label="추론 강도">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {efforts.map(({ id, label }) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DataListItem>
      )}
      {!(selection !== null) && (
        <DataListItem term="추론">
          <p className="pt-1.5 text-xs text-muted-foreground">모델을 선택하세요.</p>
        </DataListItem>
      )}
    </Section>
  );
}

const permissionModes = [
  { value: "ask", label: "매번 묻기" },
  { value: "auto", label: "자동 판단 (auto)" },
  { value: "full", label: "전체 권한 (full)" },
] satisfies ReadonlyArray<{ value: PermissionMode; label: string }>;

const projectSectionOpenAtom = atomWithStorage("context-agent-project-section-open-v2", false);

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
    <section>
      <Collapsible open={open} onOpenChange={setOpen}>
        {/* Collapsed, a selected project shows only its name; the label keeps the context. */}
        <SidebarDisclosureTrigger
          aria-label={current !== undefined ? `프로젝트 ${current.name}` : "프로젝트"}
        >
          {current !== undefined ? (
            <span className="font-medium">{current.name}</span>
          ) : (
            <span className="font-medium">프로젝트 선택</span>
          )}
        </SidebarDisclosureTrigger>
        <CollapsibleContent className="px-3 pb-2">
          <DataList className="grid-cols-[3.5rem_minmax(0,1fr)]">
            <DataListItem term="프로젝트">
              <div className="flex min-w-0 items-center gap-2">
                {projects.length > 0 ? (
                  <Select
                    value={projectId}
                    items={projects.map((project) => ({ value: project.id, label: project.name }))}
                    onValueChange={(value) => value && onSelect(value)}
                  >
                    <SelectTrigger className="min-w-0 flex-1" size="sm" aria-label="프로젝트 선택">
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
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    등록된 프로젝트가 없어요.
                  </p>
                )}
                <AddProjectDialog onAdd={onAdd} />
              </div>
            </DataListItem>
            {current && (
              <>
                <DataListItem term="권한">
                  <Select
                    value={current.permissionMode}
                    items={permissionModes}
                    onValueChange={(value) => {
                      const mode = permissionModes.find((option) => option.value === value);
                      if (isTruthy(mode)) onPermissionMode(mode.value);
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
                </DataListItem>
                <DataListItem term="기억">
                  <label className="flex min-h-8 cursor-pointer items-center justify-between gap-2">
                    <span className="text-xs">다른 프로젝트에서도 찾기</span>
                    <Switch
                      checked={!current.crossRecallExcluded}
                      onCheckedChange={(checked) => onCrossRecall(checked)}
                    />
                  </label>
                </DataListItem>
                <DataListItem term="목록">
                  <Button
                    variant="ghost-muted"
                    size="sm"
                    title="보관하기"
                    onClick={() => onHide(current.id)}
                  >
                    <EyeOffIcon /> 보관하기
                  </Button>
                </DataListItem>
              </>
            )}
          </DataList>
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
          // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
          onSubmit={(event) =>
            runUiEffect(
              Effect.gen(function* () {
                event.preventDefault();
                if (!isTruthy(root.trim())) return;
                setAdding(true);
                const failure = yield* uiPromise(() => onAdd(root.trim()));
                setAdding(false);
                setError(failure);
                if (isTruthy(failure)) return;
                setRoot("");
                setOpen(false);
              }),
            )
          }
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
            <Button type="submit" disabled={adding || !isTruthy(root.trim())}>
              {adding && <Spinner />} 추가
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const sessionLabel = (session: Session) => session.title ?? dayAndTime(session.createdAt);

/** Where in the repository a conversation ran: its branch, or else its worktree folder's name. */
const sessionPlace = (session: Session) =>
  session.branch ?? session.worktreePath?.split(/[\\/]/u).at(-1) ?? null;

/** The place filter: every conversation, those in the checkout itself, or one branch or worktree. */
type PlaceFilter = Data.TaggedEnum<{
  all: {};
  checkout: {};
  place: { readonly place: string };
}>;
const PlaceFilter = Data.taggedEnum<PlaceFilter>();

// Git branch names cannot contain ":", so these never collide with a place.
const everyPlace = ":all";
const checkoutPlace = ":checkout";

const placeFilterOf = (value: string, places: readonly string[]): PlaceFilter => {
  switch (value) {
    case checkoutPlace:
      return PlaceFilter.checkout();
    case everyPlace:
      return PlaceFilter.all();
    default:
      // A place whose last conversation left the list falls back to showing everything.
      return places.includes(value) ? PlaceFilter.place({ place: value }) : PlaceFilter.all();
  }
};

const shownIn = (filter: PlaceFilter) => (session: Session) =>
  PlaceFilter.$match(filter, {
    all: () => true,
    checkout: () => sessionPlace(session) === null,
    place: ({ place }) => sessionPlace(session) === place,
  });

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
  const [placeValue, setPlaceValue] = useState(everyPlace);
  const places = [
    ...new Set(sessions.flatMap((session) => sessionPlace(session) ?? [])),
  ].toSorted();
  const filter = placeFilterOf(placeValue, places);
  const shown = sessions.filter(shownIn(filter));
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
      {places.length > 0 && (
        <div className="px-2 pb-2">
          <Select
            value={placeValue}
            items={[
              { value: everyPlace, label: "모든 작업 위치" },
              { value: checkoutPlace, label: "저장소 본체" },
              ...places.map((place) => ({ value: place, label: place })),
            ]}
            onValueChange={(value) => value && setPlaceValue(value)}
          >
            <SelectTrigger className="w-full" size="sm" aria-label="작업 위치">
              <GitBranchIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={everyPlace}>모든 작업 위치</SelectItem>
              <SelectItem value={checkoutPlace}>저장소 본체</SelectItem>
              {places.map((place) => (
                <SelectItem key={place} value={place}>
                  {place}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {archiveError && (
        <Alert variant="destructive" className="mx-2 mb-2 w-auto">
          <AlertDescription>{archiveError}</AlertDescription>
        </Alert>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {shown.map((session) => (
            <div
              key={session.id}
              className={cn(
                "group flex items-center rounded-md hover:bg-muted",
                session.id === sessionId && "bg-muted font-medium",
              )}
            >
              <Link
                to={`/?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(session.id)}`}
                preventScrollReset
                aria-current={session.id === sessionId ? "page" : undefined}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                {sessionPlace(session) !== null && (
                  <Badge
                    variant="outline"
                    className="max-w-24 shrink-0"
                    title={session.worktreePath ?? undefined}
                  >
                    <GitBranchIcon /> <span className="truncate">{sessionPlace(session)}</span>
                  </Badge>
                )}
                {session.agent && (
                  <Badge variant="outline" className="shrink-0">
                    <BotIcon /> {session.agent}
                  </Badge>
                )}
              </Link>
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
          {sessions.length > 0 && shown.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">이 작업 위치의 대화가 없어요.</p>
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
