import { Array, Data, Effect, Option } from "effect";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { isTruthy } from "../../truthy.ts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useState } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
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
} from "~/components/ui/dialog";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "~/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { dayAndTime } from "~/lib/dates";
import {
  FolderPick,
  type ProviderModel,
  type ModelSelection,
  type PermissionMode,
  type Project,
  type Session,
} from "../api";
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
  hiddenProjects,
  projectId,
  onSelect,
  onAdd,
  onPickFolder,
  onPermissionMode,
  onCrossRecall,
  onHide,
  onRestore,
}: {
  projects: ReadonlyArray<Project>;
  /** Archived projects; choosing one releases it from the archive. */
  hiddenProjects: ReadonlyArray<Project>;
  projectId: string | null;
  onSelect: (projectId: string) => void;
  onAdd: (root: string) => Promise<string | null>;
  /** The host's folder dialog. */
  onPickFolder: () => Promise<FolderPick>;
  onPermissionMode: (mode: PermissionMode) => void;
  /** Whether conversations in other projects may recall this project's memory (R08). */
  onCrossRecall: (allowed: boolean) => void;
  /** Archives the project: out of this list; its conversations and memory stay. */
  onHide: (projectId: string) => void;
  /** Releases an archived project back into the list. */
  onRestore: (projectId: string) => void;
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
                {projects.length > 0 || hiddenProjects.length > 0 ? (
                  <ProjectCombobox
                    projects={projects}
                    hiddenProjects={hiddenProjects}
                    current={current ?? null}
                    onSelect={onSelect}
                    onRestore={onRestore}
                  />
                ) : (
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    등록된 프로젝트가 없어요.
                  </p>
                )}
                <OpenFolderButton
                  projects={projects}
                  onAdd={onAdd}
                  onSelect={onSelect}
                  onPickFolder={onPickFolder}
                />
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
                    title="프로젝트 보관"
                    onClick={() => onHide(current.id)}
                  >
                    <ArchiveIcon /> 보관하기
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

const archivedGroup = "보관된 프로젝트";

/** Picks among the projects by name; archived ones sit in their own group and come back when chosen. */
function ProjectCombobox({
  projects,
  hiddenProjects,
  current,
  onSelect,
  onRestore,
}: {
  projects: ReadonlyArray<Project>;
  hiddenProjects: ReadonlyArray<Project>;
  current: Project | null;
  onSelect: (projectId: string) => void;
  onRestore: (projectId: string) => void;
}) {
  const groups = [
    { value: "프로젝트", items: projects },
    ...(hiddenProjects.length > 0 ? [{ value: archivedGroup, items: hiddenProjects }] : []),
  ];
  return (
    <Combobox
      items={groups}
      value={current}
      itemToStringLabel={(project: Project) => project.name}
      isItemEqualToValue={(item: Project, value: Project) => item.id === value.id}
      onValueChange={(project: Project | null) => {
        if (project === null) return;
        if (project.hiddenAt !== null) onRestore(project.id);
        else onSelect(project.id);
      }}
    >
      <ComboboxInput
        className="h-6 min-w-0 flex-1"
        placeholder="프로젝트 검색"
        aria-label="프로젝트 선택"
      />
      <ComboboxContent>
        <ComboboxEmpty>맞는 프로젝트가 없어요.</ComboboxEmpty>
        <ComboboxList>
          {(group: (typeof groups)[number]) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {groups.length > 1 && <ComboboxLabel>{group.value}</ComboboxLabel>}
              <ComboboxCollection>
                {(project: Project) => (
                  <ComboboxItem key={project.id} value={project} title={project.root}>
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {project.hiddenAt !== null && (
                      <span className="flex shrink-0 items-center gap-1 pr-5 text-muted-foreground">
                        <ArchiveRestoreIcon /> 보관 해제
                      </span>
                    )}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * Adds a project from the host's folder dialog. Registering a folder widens what the file tools
 * may touch, so the server still checks the path. Without a dialog on the host, or when the
 * chosen folder is refused, the path dialog opens with what is known so far.
 */
function OpenFolderButton({
  projects,
  onAdd,
  onSelect,
  onPickFolder,
}: {
  projects: ReadonlyArray<Project>;
  onAdd: (root: string) => Promise<string | null>;
  onSelect: (projectId: string) => void;
  onPickFolder: () => Promise<FolderPick>;
}) {
  const [picking, setPicking] = useState(false);
  const [fallback, setFallback] = useState<{ root: string; error: string | null } | null>(null);

  // A folder already in the list is simply chosen; adding it again would be refused.
  const add = (root: string) =>
    Option.match(
      Array.findFirst(projects, (project) => project.root === root),
      {
        onNone: () => onAdd(root),
        onSome: (known) => {
          onSelect(known.id);
          return Promise.resolve(null);
        },
      },
    );

  // A refused folder opens the path dialog on it, with the reason.
  const addPicked = (root: string) =>
    uiPromise(() => add(root)).pipe(
      Effect.flatMap((error) =>
        Effect.sync(() => setFallback({ root, error })).pipe(
          Effect.when(Effect.succeed(isTruthy(error))),
        ),
      ),
      Effect.asVoid,
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const open = () =>
    runUiEffect(
      Effect.gen(function* () {
        setPicking(true);
        const pick = yield* uiPromise(onPickFolder).pipe(
          Effect.ensuring(Effect.sync(() => setPicking(false))),
        );
        yield* FolderPick.match(pick, {
          cancelled: () => Effect.void,
          unavailable: () => Effect.sync(() => setFallback({ root: "", error: null })),
          picked: ({ root }) => addPicked(root),
        });
      }).pipe(
        Effect.catchTag("UnknownError", () =>
          Effect.sync(() => setFallback({ root: "", error: null })),
        ),
      ),
    );

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        aria-label="폴더 열기"
        title="폴더 열기"
        disabled={picking}
        onClick={() => void open()}
      >
        {picking ? <Spinner /> : <FolderOpenIcon />}
      </Button>
      {fallback !== null && (
        <AddProjectDialog
          initialRoot={fallback.root}
          initialError={fallback.error}
          onAdd={add}
          onClose={() => setFallback(null)}
        />
      )}
    </>
  );
}

/** Typing the path: for hosts without a folder dialog, or to correct a refused folder. */
function AddProjectDialog({
  initialRoot,
  initialError,
  onAdd,
  onClose,
}: {
  initialRoot: string;
  initialError: string | null;
  onAdd: (root: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [root, setRoot] = useState(initialRoot);
  const [error, setError] = useState<string | null>(initialError);
  const [adding, setAdding] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
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
                onClose();
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
  loading,
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
  /** The list has not arrived yet, so an empty one says nothing. */
  loading: boolean;
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
  // The asked-about conversation stays while the dialog closes, so its title does not blank out.
  const [deleteAsk, setDeleteAsk] = useState<{
    readonly session: Session;
    readonly open: boolean;
  } | null>(null);
  const places = [
    ...new Set(sessions.flatMap((session) => sessionPlace(session) ?? [])),
  ].toSorted();
  const filter = placeFilterOf(placeValue, places);
  const shown = sessions.filter(shownIn(filter));
  const everywhere = PlaceFilter.$is("all")(filter);
  const placeLabel = PlaceFilter.$match(filter, {
    all: () => "모든 작업 위치",
    checkout: () => "저장소 본체",
    place: ({ place }) => place,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h2 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">대화</h2>
        <div className="flex min-w-0 items-center">
          {places.length > 0 && (
            <DropdownMenu>
              {/* A filter in use names its place, so a short list is not mistaken for all of it. */}
              <DropdownMenuTrigger
                render={
                  <Button
                    variant={everywhere ? "ghost" : "secondary"}
                    size={everywhere ? "icon-sm" : "sm"}
                    aria-label={`작업 위치: ${placeLabel}`}
                    title={`작업 위치: ${placeLabel}`}
                  />
                }
              >
                <GitBranchIcon />
                {!everywhere && <span className="max-w-20 truncate">{placeLabel}</span>}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>작업 위치</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={placeValue}
                    onValueChange={(value: string) => setPlaceValue(value)}
                  >
                    <DropdownMenuRadioItem value={everyPlace}>모든 작업 위치</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value={checkoutPlace}>저장소 본체</DropdownMenuRadioItem>
                    {places.map((place) => (
                      <DropdownMenuRadioItem key={place} value={place} title={place}>
                        <span className="min-w-0 flex-1 truncate">{place}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {/* Fixed widths: the server renders this too, and a random one would not hydrate. */}
            {loading && (
              <SidebarMenuItem>
                <div className="flex flex-col gap-4 p-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </SidebarMenuItem>
            )}
            {shown.map((session) => (
              <SidebarMenuItem key={session.id}>
                <SidebarMenuButton
                  isActive={session.id === sessionId}
                  render={
                    <Link
                      to={`/?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(session.id)}`}
                      preventScrollReset
                      aria-current={session.id === sessionId ? "page" : undefined}
                    />
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                  {/* Only a separate worktree is worth a chip; a filtered list is all one place. */}
                  {everywhere && session.worktreePath !== null && (
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
                </SidebarMenuButton>
                {/* One menu on hover or focus keeps the row's width for its title. */}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuAction showOnHover aria-label={`${sessionLabel(session)} 메뉴`} />
                    }
                  >
                    <EllipsisIcon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start">
                    <DropdownMenuItem
                      onClick={() => onArchive(session.id)}
                      title="실행 중이면 안전하게 중단하고 기억은 남겨요"
                    >
                      <ArchiveIcon /> 보관하기
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setDeleteAsk({ session, open: true })}
                    >
                      <Trash2Icon /> 원본 삭제
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          {!loading && sessions.length === 0 && (
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
                      onClick={() => setDeleteAsk({ session, open: true })}
                    >
                      <Trash2Icon /> 삭제
                    </Button>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </SidebarGroup>
      </SidebarContent>
      <AlertDialog
        open={deleteAsk?.open === true}
        onOpenChange={(open) =>
          setDeleteAsk((current) => (current === null ? null : { ...current, open }))
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>대화 원본을 삭제할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteAsk === null
                ? ""
                : `"${sessionLabel(deleteAsk.session)}" 대화의 원본을 지워요. `}
              채택된 project memory와 Work Trace provenance는 유지돼요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteAsk !== null) onDelete(deleteAsk.session.id);
                setDeleteAsk((current) => (current === null ? null : { ...current, open: false }));
              }}
            >
              삭제
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export { Separator };
