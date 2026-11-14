import { ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
  FolderXIcon,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import { dayAndTime } from "~/lib/dates";
import { useHydrated } from "../shared/use-hydrated";
import {
  FolderPick,
  type ProviderModel,
  type ModelSelection,
  type ListedProject,
  type Session,
} from "../api";
import { DataList, DataListItem } from "~/components/ui/data-list";
import type { ProjectWorking } from "../queries/project";
import { LoadFailed } from "../shared/load-failed";
import { effortChoices } from "./providers";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="px-4 py-2 not-last:border-b">
      <DataList className="grid-cols-[3.5rem_minmax(0,1fr)]">{children}</DataList>
    </section>
  );
}

export function ModelSection({
  models,
  selection,
  busy = false,
  error = null,
  onSelect,
}: {
  models: ReadonlyArray<ProviderModel>;
  selection: ModelSelection | null;
  /** A model change is being saved. */
  busy?: boolean;
  /** Why the last model change failed. */
  error?: string | null;
  onSelect: (model: string, reasoningEffort?: string) => void;
}) {
  const { t } = useLingui();
  const current = models.find((model) => model.id === selection?.model);
  const efforts =
    current !== undefined && selection !== null ? effortChoices(selection, current) : [];
  const modelTerm = t({ message: "모델", comment: "Sidebar field label: the chat model" });
  const effortTerm = t({ message: "추론", comment: "Sidebar field label: reasoning effort" });
  return (
    <Section title={t({ message: "모델", comment: "Sidebar section of model settings" })}>
      <DataListItem term={modelTerm}>
        <Select
          value={selection?.model ?? null}
          items={models.map((model) => ({ value: model.id, label: model.displayName }))}
          disabled={busy}
          onValueChange={(value) => value && onSelect(value)}
        >
          <SelectTrigger className="w-full" size="sm" aria-label={modelTerm}>
            <SelectValue
              placeholder={t({
                message: "모델 선택",
                comment: "Placeholder of the model picker when none is chosen",
              })}
            />
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
        <DataListItem term={effortTerm}>
          <Select
            value={selection.reasoningEffort}
            items={efforts.map(({ id, label }) => ({ value: id, label }))}
            disabled={busy}
            onValueChange={(value) => value && onSelect(current.id, value)}
          >
            <SelectTrigger
              className="w-full"
              size="sm"
              aria-label={t({
                message: "추론 강도",
                comment: "Picker of the model's reasoning effort",
              })}
            >
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
        <DataListItem term={effortTerm}>
          <p className="pt-1.5 text-xs text-muted-foreground">
            <Trans>모델을 선택해 주십시오.</Trans>
          </p>
        </DataListItem>
      )}
      {error && <p className="col-span-2 text-2xs text-destructive">{error}</p>}
    </Section>
  );
}

/**
 * How each project's conversation group sits in the list: folded or open, kept per browser. The
 * server renders and hydrates with the empty default and the stored folds are read once the
 * browser takes over, so the first paint never disagrees with the server's HTML.
 */
const sessionGroupsOpenAtom = atomWithStorage<Readonly<Record<string, boolean>>>(
  "context-agent-session-groups-open-v1",
  {},
);

/** What a project whose folder is gone says, where it can be archived. */
export function MissingFolderNotice({ root }: { root: string }) {
  return (
    <Trans>
      프로젝트 폴더({root})가 없습니다. 옮기거나 지웠다면 이 프로젝트를 보관해 주십시오. 대화와
      기억은 남습니다.
    </Trans>
  );
}

/**
 * Adds a project from the host's folder dialog. Registering a folder widens what the file tools
 * may touch, so the server still checks the path. Without a dialog on the host, or when the
 * chosen folder is refused, the path dialog opens with what is known so far.
 */
export function OpenFolderButton({
  projects,
  onAdd,
  onSelect,
  onPickFolder,
  label,
}: {
  projects: ReadonlyArray<ListedProject>;
  onAdd: (root: string) => Promise<string | null>;
  onSelect: (projectId: string) => void;
  onPickFolder: () => Promise<FolderPick>;
  /** Shown next to the icon; without it the button is the sidebar's icon button. */
  label?: string;
}) {
  const { t } = useLingui();
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
        size={label === undefined ? "icon-sm" : "default"}
        aria-label={
          label ??
          t({
            message: "폴더 열기",
            comment: "Button that adds a project from a folder",
          })
        }
        title={t({ message: "폴더 열기", comment: "Button that adds a project from a folder" })}
        disabled={picking}
        onClick={() => void open()}
      >
        {picking ? <Spinner /> : <FolderOpenIcon />}
        {label}
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
          <DialogTitle>
            <Trans>프로젝트 추가</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              폴더의 절대 경로를 입력해 주십시오. 등록한 폴더 안의 파일은 에이전트가 읽고 고칠 수
              있습니다.
            </Trans>
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
            <FieldLabel htmlFor="project-root">
              <Trans>폴더 경로</Trans>
            </FieldLabel>
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
            <DialogClose render={<Button type="button" variant="outline" />}>
              <Trans comment="Button that closes the add project dialog">취소</Trans>
            </DialogClose>
            <Button type="submit" disabled={adding || !isTruthy(root.trim())}>
              {adding && <Spinner />} <Trans comment="Button that adds the project">추가</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A conversation's title. One without a title yet reads as when it started, in the browser's time
 * zone, so the server's HTML and its hydration name it in words instead.
 */
const sessionLabel = (hydrated: boolean) => (session: Session) =>
  session.title ?? (hydrated ? dayAndTime(session.createdAt) : t`제목 없는 대화`);

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

/** Conversations at work lead their project's group: answering, or running their board. */
const atWork = (session: Session, working: ProjectWorking) =>
  working.answering.has(session.id) || working.boardRunning.has(session.id);

/** One listed project and what the list shows of it: its conversations and archived ones. */
interface ProjectGroup {
  readonly projectId: string;
  readonly name: string;
  readonly sessions: ReadonlyArray<Session>;
  readonly archived: ReadonlyArray<Session>;
  /** The project's folder is gone from disk. */
  readonly folderMissing: boolean;
}

/** One project's part of the conversation list: its header, place filter, groups and archive. */
function ProjectSessionGroup({
  group,
  selected,
  working,
  label,
  row,
  actions,
  onRestore,
  onDeleteAsk,
}: {
  group: ProjectGroup;
  /** The project of the open conversation; its group starts open when no fold was stored. */
  readonly selected: boolean;
  /** The buttons on the header row: start a conversation, the project's menu. */
  readonly actions: React.ReactNode;
  /** The project's conversations at work now, which lead the group and fill the badge. */
  readonly working: ProjectWorking;
  readonly label: (session: Session) => string;
  readonly row: (session: Session) => React.ReactNode;
  /** Puts an archived conversation back in the list, in its own project. */
  readonly onRestore: (projectId: string, sessionId: string) => void;
  /** Asks before deleting the conversation's source record. */
  readonly onDeleteAsk: (ask: { readonly session: Session; readonly open: boolean }) => void;
}) {
  const { t } = useLingui();
  const [placeValue, setPlaceValue] = useState(everyPlace);
  // Whether the group is folded lives in the browser's storage, so the list comes back the way it
  // was left. The atom starts empty on the server and the first render, then the stored folds
  // arrive on mount; a project the user never touched keeps the old default (open when selected).
  const [folds, setFolds] = useAtom(sessionGroupsOpenAtom);
  const open = folds[group.projectId] ?? selected;
  const setOpen = (next: boolean) =>
    setFolds((current) => ({ ...current, [group.projectId]: next }));
  const places = [
    ...new Set(group.sessions.flatMap((session) => sessionPlace(session) ?? [])),
  ].toSorted();
  const filter = placeFilterOf(placeValue, places);
  const shown = group.sessions.filter(shownIn(filter));
  // `filter` builds `shown` either way; counting through it again reads clearer than another pass.
  const leading = shown.filter((session) => atWork(session, working));
  const rest = shown.filter((session) => !atWork(session, working));
  const everywhere = PlaceFilter.$is("all")(filter);
  const everyPlaceLabel = t({
    message: "모든 작업 위치",
    comment: "Place filter option: conversations from every branch and worktree",
  });
  const checkoutLabel = t({
    message: "저장소 본체",
    comment: "Place filter option: conversations in the repository checkout, not a worktree",
  });
  const placeLabel = PlaceFilter.$match(filter, {
    all: () => everyPlaceLabel,
    checkout: () => checkoutLabel,
    place: ({ place }) => place,
  });
  return (
    <SidebarGroup>
      <Collapsible open={open} onOpenChange={setOpen}>
        {/* The project's name pins to the top of the scrolling list while its group is in view,
            like the section headings below it. It sits above them (z-20 over their z-10, h-8
            offset) so a scrolling section heading passes under the project's name instead of
            covering it. The count stays readable when the group is folded, as its only content. */}
        {/* The header row is a sibling of the folding trigger: a button cannot hold the project's
            action buttons. The row carries the pinning, the trigger the folding. */}
        <div className="sticky top-0 z-20 flex h-8 items-center gap-0.5 rounded-md bg-sidebar pr-1">
          <CollapsibleTrigger
            className="group flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-xs font-semibold text-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            title={group.name}
          >
            <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
            <span className="min-w-0 truncate text-left">{group.name}</span>
            {group.folderMissing && (
              <span className="flex shrink-0 text-destructive" title={t`프로젝트 폴더가 없습니다`}>
                <FolderXIcon className="size-3.5" aria-hidden />
              </span>
            )}
            <span className="flex-1" />
            {/* Readable while the group is folded too, when it is the only context. */}
            {!open && (
              <span
                className="shrink-0 tabular-nums text-2xs font-medium text-muted-foreground"
                aria-label={t({
                  message: `대화 ${ph({ count: group.sessions.length })}개`,
                  comment: "How many conversations the project's group header shows",
                })}
              >
                {group.sessions.length}
              </span>
            )}
            {/* How many conversations of this project are at work now; none is the usual state. */}
            {leading.length > 0 && (
              <Badge
                variant="default"
                aria-label={t({
                  message: `진행 중 ${ph({ count: leading.length })}개`,
                  comment: "How many conversations the project has at work now",
                })}
              >
                <Spinner className="size-2.5" aria-hidden />
                {leading.length}
              </Badge>
            )}
          </CollapsibleTrigger>
          {actions}
        </div>
        <CollapsibleContent className="flex flex-col gap-0.5">
          {group.sessions.length === 0 ? (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              <Trans>아직 대화가 없습니다.</Trans>
            </p>
          ) : (
            <>
              {places.length > 0 && (
                <div className="px-2 py-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant={everywhere ? "ghost-muted" : "secondary"}
                          size="sm"
                          className="w-full justify-start"
                          aria-label={t({
                            message: `작업 위치: ${placeLabel}`,
                            comment:
                              "Place filter button; placeLabel is the branch or worktree shown",
                          })}
                          title={t({
                            message: `작업 위치: ${placeLabel}`,
                            comment:
                              "Place filter button; placeLabel is the branch or worktree shown",
                          })}
                        />
                      }
                    >
                      <GitBranchIcon />
                      <span className="min-w-0 flex-1 truncate text-left">{placeLabel}</span>
                      <ChevronDownIcon className="text-muted-foreground" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>
                          <Trans comment="Place filter menu heading: a branch or worktree">
                            작업 위치
                          </Trans>
                        </DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={placeValue}
                          onValueChange={(value: string) => setPlaceValue(value)}
                        >
                          <DropdownMenuRadioItem value={everyPlace}>
                            {everyPlaceLabel}
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value={checkoutPlace}>
                            {checkoutLabel}
                          </DropdownMenuRadioItem>
                          {places.map((place) => (
                            <DropdownMenuRadioItem key={place} value={place} title={place}>
                              <span className="min-w-0 flex-1 truncate">{place}</span>
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
              {places.length > 0 && shown.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  <Trans>이 작업 위치의 대화가 없습니다.</Trans>
                </p>
              )}
              <SessionGroup
                title={t({
                  message: "진행 중",
                  comment: "Conversation list section: conversations answering or running a board",
                })}
                count={leading.length}
                defaultOpen
              >
                {leading.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    <Trans>진행 중인 대화가 없습니다.</Trans>
                  </p>
                ) : (
                  <SidebarMenu>{leading.map(row)}</SidebarMenu>
                )}
              </SessionGroup>
              <SessionGroup
                title={t({
                  message: "대화",
                  comment: "Conversation list section: the conversations not at work",
                })}
                count={rest.length}
                defaultOpen
              >
                {rest.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    <Trans>다른 대화가 없습니다.</Trans>
                  </p>
                ) : (
                  <SidebarMenu>{rest.map(row)}</SidebarMenu>
                )}
              </SessionGroup>
              {group.archived.length > 0 && (
                <SessionGroup
                  title={t({
                    message: "보관함",
                    comment: "Conversation list section: archived conversations",
                  })}
                  count={group.archived.length}
                >
                  <SidebarMenu>
                    {group.archived.map((session) => (
                      <SidebarMenuItem key={session.id}>
                        {/* An archived conversation is out of the list, so its row opens its actions. */}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <SidebarMenuButton
                                title={t`목록에서만 뺀 대화입니다. 기억 검색에는 계속 나옵니다.`}
                                aria-label={label(session)}
                              />
                            }
                          >
                            <span className="min-w-0 flex-1 truncate">{label(session)}</span>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start">
                            <DropdownMenuItem
                              onClick={() => onRestore(session.projectId, session.id)}
                            >
                              <ArchiveRestoreIcon />{" "}
                              <Trans comment="Menu item that brings the conversation back to the list">
                                복원
                              </Trans>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => onDeleteAsk({ session, open: true })}
                            >
                              <Trash2Icon />{" "}
                              <Trans comment="Menu item that deletes the conversation's source record">
                                원본 삭제
                              </Trans>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SessionGroup>
              )}
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}

/** Archived projects, folded below the list; each can be released back into it. */
export function ArchivedProjects({
  projects,
  onRestore,
}: {
  projects: ReadonlyArray<ListedProject>;
  /** Releases an archived project back into the list. */
  onRestore: (projectId: string) => void;
}) {
  const { t } = useLingui();
  return projects.length === 0 ? null : (
    <SidebarGroup>
      <Collapsible>
        <CollapsibleTrigger className="group flex h-8 w-full items-center gap-1 rounded-md px-2 text-xs font-semibold text-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
          <span className="min-w-0 flex-1 truncate text-left">
            <Trans comment="Sidebar section heading: the archived projects">보관된 프로젝트</Trans>
          </span>
          <span
            className="tabular-nums text-2xs font-medium text-muted-foreground"
            aria-label={t({
              message: `${ph({ count: projects.length })}개`,
              comment: "How many archived projects the section holds",
            })}
          >
            {projects.length}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenu>
            {projects.map((project) => {
              const restoreLabel = t({
                message: `${ph({ name: project.name })} 보관 해제`,
                comment: "Button that releases an archived project; name is the project's name",
              });
              return (
                <SidebarMenuItem key={project.id}>
                  <div className="flex h-8 items-center gap-1 px-2 text-xs" title={project.root}>
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={restoreLabel}
                      title={restoreLabel}
                      onClick={() => onRestore(project.id)}
                    >
                      <ArchiveRestoreIcon />
                    </Button>
                  </div>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}

/** One section of the conversation list: a heading that folds it, with how many it holds. */
function SessionGroup({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useLingui();
  // The heading sticks to the top of the scrolling list while its section is in view; the next
  // section's heading pushes it out, since a sticky element stays inside its own section. Inside
  // a project group it stops below the project's pinned name (its h-8, the group's z-20), so the
  // two rows stay readable while both are stuck.
  return (
    <SidebarGroup>
      <Collapsible defaultOpen={defaultOpen}>
        <CollapsibleTrigger className="group sticky top-8 z-10 flex h-8 w-full items-center gap-1 rounded-md bg-sidebar px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
          <span className="min-w-0 flex-1 truncate text-left">{title}</span>
          <span
            className="tabular-nums"
            aria-label={t({
              message: `${count}개`,
              comment: "How many conversations the section holds",
            })}
          >
            {count}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-0.5">{children}</CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}

/**
 * The sidebar lists every project's conversations as one collapsible group per project. Every
 * listed project is a group, with or without conversations; its header starts a conversation in
 * it and opens its menu.
 */
export function SessionSection({
  groups,
  working,
  loading,
  failed = false,
  onRetry = () => {},
  projectId,
  sessionId,
  archiveError,
  onCreate,
  onArchive,
  onDelete,
  onRestore,
  header,
  projectActions,
}: {
  /** One group per listed project: its name, and its conversations and archived ones. */
  groups: ReadonlyArray<ProjectGroup>;
  /** One entry per listed project: its conversations at work now, which lead its group. */
  working: ReadonlyArray<ProjectWorking>;
  /** No group's list has arrived yet, so an empty one says nothing. */
  loading: boolean;
  /** Some list could not be read; missing groups would say there are no conversations. */
  failed?: boolean;
  /** Reads the failed lists again. */
  onRetry?: () => void;
  /** The project of the open conversation, if one is open. */
  projectId: string | null;
  sessionId: string | null;
  /** Why the last archive, restore or project change was refused, if it was. */
  archiveError: string | null;
  /** Starts a conversation in the project, on the app's model. */
  onCreate: (projectId: string) => void;
  onArchive: (projectId: string, sessionId: string) => void;
  onDelete: (projectId: string, sessionId: string) => void;
  onRestore: (projectId: string, sessionId: string) => void;
  /** The list's top row: what adds a project. */
  header: React.ReactNode;
  /** The project's menu, drawn next to its new-conversation button. */
  projectActions: (projectId: string) => React.ReactNode;
}) {
  const { t } = useLingui();
  const label = sessionLabel(useHydrated());
  /** One project's conversations at work now, which lead that project's group. */
  const workingOf = (groupProjectId: string): ProjectWorking =>
    working.find((project) => project.projectId === groupProjectId) ?? {
      projectId: groupProjectId,
      answering: new Set<string>(),
      boardRunning: new Set<string>(),
    };
  // The asked-about conversation stays while the dialog closes, so its title does not blank out.
  const [deleteAsk, setDeleteAsk] = useState<{
    readonly session: Session;
    readonly open: boolean;
  } | null>(null);
  const menuLabel = (session: Session) =>
    t({
      message: `${ph({ title: label(session) })} 메뉴`,
      comment: "Button that opens a conversation's menu; title is the conversation's title",
    });
  const newLabel = (name: string) =>
    t({
      message: `${ph({ name })}에 새 대화`,
      comment: "Button on a project's header that starts a conversation in it",
    });
  const deleteTitle = deleteAsk === null ? null : label(deleteAsk.session);
  const row = (session: Session) => {
    // The project's working set the row is judged by: the one its own project's group leads with.
    const projectWorking = workingOf(session.projectId);
    return (
      <SidebarMenuItem key={session.id}>
        <SidebarMenuButton
          isActive={session.id === sessionId && session.projectId === projectId}
          render={
            <Link
              to={`/?project=${encodeURIComponent(session.projectId)}&session=${encodeURIComponent(session.id)}`}
              preventScrollReset
              aria-current={
                session.id === sessionId && session.projectId === projectId ? "page" : undefined
              }
            />
          }
        >
          <span className="min-w-0 flex-1 truncate">{label(session)}</span>
          {session.worktreePath !== null && (
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
          {atWork(session, projectWorking) && (
            <span className="flex shrink-0 text-muted-foreground">
              <Spinner
                aria-label={
                  projectWorking.answering.has(session.id)
                    ? t({
                        message: "답변 중",
                        comment: "Conversation status: an answer is streaming",
                      })
                    : t({
                        message: "보드 실행 중",
                        comment: "Conversation status: its kanban board is running",
                      })
                }
              />
            </span>
          )}
        </SidebarMenuButton>
        {/* One menu on hover or focus keeps the row's width for its title. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuAction showOnHover aria-label={menuLabel(session)} />}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem
              onClick={() => onArchive(session.projectId, session.id)}
              title={t`실행 중이면 안전하게 중단하고 기억은 남깁니다`}
            >
              <ArchiveIcon />{" "}
              <Trans comment="Menu item that archives the conversation">보관하기</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleteAsk({ session, open: true })}
            >
              <Trash2Icon />{" "}
              <Trans comment="Menu item that deletes the conversation's source record">
                원본 삭제
              </Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The list's actions come first, then its sections; no title row competes with them. */}
      <div className="flex px-2 pt-3 pb-1">{header}</div>
      {archiveError && (
        <Alert variant="destructive" className="mx-2 mb-2 w-auto">
          <AlertDescription>{archiveError}</AlertDescription>
        </Alert>
      )}
      <SidebarContent>
        {/* Fixed widths: the server renders this too, and a random one would not hydrate. */}
        {loading && (
          <div className="flex flex-col gap-4 p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        {failed && (
          <LoadFailed className="px-4 py-2" onRetry={onRetry}>
            <Trans>대화 목록을 불러오지 못했습니다.</Trans>
          </LoadFailed>
        )}
        {/* One project group after another: same heading shape, that project's conversations.
            A project without conversations is a group too: its header starts the first one. */}
        {groups.map((group) => (
          <ProjectSessionGroup
            key={group.projectId}
            group={group}
            selected={group.projectId === projectId}
            working={workingOf(group.projectId)}
            label={label}
            row={row}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={newLabel(group.name)}
                  title={newLabel(group.name)}
                  onClick={() => onCreate(group.projectId)}
                >
                  <PlusIcon />
                </Button>
                {projectActions(group.projectId)}
              </>
            }
            onRestore={onRestore}
            onDeleteAsk={setDeleteAsk}
          />
        ))}
        {!loading && !failed && groups.length === 0 && (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            <Trans>아직 대화가 없습니다.</Trans>
          </p>
        )}
      </SidebarContent>
      <AlertDialog
        open={deleteAsk?.open === true}
        onOpenChange={(open) =>
          setDeleteAsk((current) => (current === null ? null : { ...current, open }))
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>대화 원본을 삭제할까요?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTitle === null ? "" : `${t`"${deleteTitle}" 대화의 원본을 지웁니다.`} `}
              <Trans>프로젝트 기억으로 채택된 내용과 그 출처 기록은 남습니다.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans comment="Dialog button that cancels">취소</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteAsk !== null) onDelete(deleteAsk.session.projectId, deleteAsk.session.id);
                setDeleteAsk((current) => (current === null ? null : { ...current, open: false }));
              }}
            >
              <Trans comment="Dialog button that confirms deleting the conversation's source">
                삭제
              </Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export { Separator };
