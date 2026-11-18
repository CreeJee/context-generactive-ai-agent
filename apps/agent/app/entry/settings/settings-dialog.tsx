import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  BookOpenIcon,
  BotIcon,
  CpuIcon,
  GlobeIcon,
  HistoryIcon,
  ImageIcon,
  KanbanIcon,
  MessagesSquareIcon,
  PlugIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  WaypointsIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { type Project } from "../api";
import { MissingFolderNotice } from "../navigation/sidebar";
import { useProjectsQuery } from "../queries/global";
import { useHideProjectMutation } from "../queries/mutations/project";
import { QuerySection } from "../queries/boundary";
import { ImageSettings } from "./pages/image";
import { KagiSettings } from "./pages/web";
import { ImportSettings } from "./pages/imports";
import { ConversationSettings } from "./pages/conversation";
import { RecallSettings } from "./pages/recall";
import { EmbeddingSettings } from "./pages/embedding";
import { McpSettings } from "./pages/mcp";
import { AgentSettings } from "./pages/agents";
import { PermissionSettings } from "./pages/permission";
import { SkillSettings } from "./pages/skills";
import { GeneralSettings } from "./pages/general";
import { KanbanSettings } from "./pages/kanban";
import { pageTitles } from "./shared";

const settingsGroups = [
  {
    id: "general",
    label: msg({
      message: "일반",
      comment: "Settings tab group: pages about the app itself, not one project",
    }),
    pages: [
      { value: "general", icon: SlidersHorizontalIcon },
      { value: "conversation", icon: MessagesSquareIcon },
    ],
  },
  {
    id: "tools",
    label: msg({ message: "도구", comment: "Settings tab group: web search and image generation" }),
    pages: [
      { value: "web", icon: GlobeIcon },
      { value: "image", icon: ImageIcon },
    ],
  },
  {
    id: "memory",
    label: msg({
      message: "기억",
      comment: "Settings tab group: pages about the app's stored conversation memory",
    }),
    pages: [
      { value: "recall", icon: WaypointsIcon },
      { value: "imports", icon: HistoryIcon },
      { value: "embedding", icon: CpuIcon },
    ],
  },
  {
    id: "project",
    label: msg({
      message: "프로젝트",
      comment:
        "Settings tab group: pages that apply to the project chosen at the top of this group",
    }),
    pages: [
      { value: "permission", icon: ShieldCheckIcon },
      { value: "mcp", icon: PlugIcon },
      { value: "agents", icon: BotIcon },
      { value: "skills", icon: BookOpenIcon },
    ],
  },
  {
    id: "run",
    label: msg({
      message: "실행",
      comment: "Settings tab group: how Goals run on the kanban board",
    }),
    pages: [{ value: "kanban", icon: KanbanIcon }],
  },
] as const;

export type SettingsPage = (typeof settingsGroups)[number]["pages"][number]["value"];

/** Each page's body; every page reads its own data, so each gets its own loading boundary. */
const pageBodies: Record<SettingsPage, (project: Project | null, reportLink: string) => ReactNode> =
  {
    general: (_project, reportLink) => <GeneralSettings reportLink={reportLink} />,
    web: () => <KagiSettings />,
    image: () => <ImageSettings />,
    mcp: (project) => <McpSettings project={project} />,
    agents: (project) => <AgentSettings project={project} />,
    permission: (project) => <PermissionSettings project={project} />,
    conversation: () => <ConversationSettings />,
    recall: () => <RecallSettings />,
    imports: () => <ImportSettings />,
    embedding: () => <EmbeddingSettings />,
    skills: (project) => <SkillSettings project={project} />,
    kanban: (project) => <KanbanSettings project={project} />,
  };

function SettingsPageBody({
  page,
  project,
  reportLink,
}: {
  page: SettingsPage;
  project: Project | null;
  reportLink: string;
}) {
  return <QuerySection>{pageBodies[page](project, reportLink)}</QuerySection>;
}

/** The pages that read the chosen project; the project picker shows only on these. */
const projectPages: ReadonlyArray<SettingsPage> = [
  "permission",
  "mcp",
  "agents",
  "skills",
  "kanban",
];

interface PageEntry {
  readonly value: SettingsPage;
  readonly icon: LucideIcon;
}

const allPages = settingsGroups.flatMap((group): ReadonlyArray<PageEntry> => group.pages);

/** The selected project's folder is gone: say so above every page, and offer to archive it. */
function MissingFolderAlert({ project, onArchived }: { project: Project; onArchived: () => void }) {
  const hide = useHideProjectMutation();
  const [failed, setFailed] = useState(false);
  return (
    <Alert variant="destructive">
      <AlertDescription>
        <MissingFolderNotice root={project.root} />
        {failed && (
          <>
            {" "}
            <Trans>프로젝트를 보관하지 못했습니다. 잠시 뒤 다시 시도해 주십시오.</Trans>
          </>
        )}
      </AlertDescription>
      <AlertAction>
        <Button
          size="sm"
          variant="outline"
          disabled={hide.isPending}
          onClick={() => {
            setFailed(false);
            hide.mutateAsync(project.id).then(onArchived, () => setFailed(true));
          }}
        >
          <Trans comment="Button that archives the project">보관하기</Trans>
        </Button>
      </AlertAction>
    </Alert>
  );
}

/**
 * Settings that apply beyond one conversation. The dialog keeps one size while pages change; a
 * page scrolls inside it.
 */
export function SettingsOverlay({
  projectId,
  open,
  onClose,
  initialPage = "general",
  reportLink,
}: {
  projectId: string | null;
  initialPage?: SettingsPage;
  /** Where the general page's problem report link goes. */
  reportLink: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const projects = useProjectsQuery().data ?? [];
  const [chosenId, setChosenId] = useState(projectId);
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const showsProject = projectPages.includes(page);
  const project = projects.find((item) => item.id === chosenId) ?? null;
  const projectItems = projects.map((item) => ({ value: item.id, label: item.name }));
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex h-[min(40rem,calc(100dvh-2rem))] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            <Trans comment="Title of the app settings dialog">설정</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>대화 밖에서 쓰는 도구와 연결을 관리합니다.</Trans>
          </DialogDescription>
        </DialogHeader>
        {showsProject && project?.folderMissing === true && (
          <MissingFolderAlert project={project} onArchived={onClose} />
        )}
        <Tabs
          value={page}
          onValueChange={(value) => {
            const next = allPages.find((item) => item.value === value);
            if (next !== undefined) setPage(next.value);
          }}
          orientation="vertical"
          className="min-h-0 flex-1"
        >
          <div className="mr-2 w-40 shrink-0 border-r pr-3">
            <TabsList variant="nav" className="w-full items-stretch justify-start">
              {settingsGroups.map((group) => (
                <div key={group.id} className="flex flex-col gap-0.5 not-first:pt-3">
                  <div className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                    {t(group.label)}
                  </div>
                  {group.id === "project" && projects.length > 0 && (
                    <div className="px-1 pb-1">
                      <Select
                        value={chosenId}
                        items={projectItems}
                        onValueChange={(value) => setChosenId(value)}
                      >
                        <SelectTrigger
                          id="settings-project"
                          size="sm"
                          className="w-full"
                          aria-label={t({
                            message: "설정할 프로젝트",
                            comment:
                              "Accessible name of the settings sidebar's project picker; the pages in this group and the kanban page's protected branches use the chosen project",
                          })}
                        >
                          <SelectValue
                            placeholder={t({
                              message: "프로젝트 고르기",
                              comment: "Placeholder of the settings dialog's project picker",
                            })}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {projectItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {group.pages.map((page) => (
                    <TabsTrigger key={page.value} value={page.value}>
                      <page.icon />
                      {t(pageTitles[page.value])}
                    </TabsTrigger>
                  ))}
                </div>
              ))}
            </TabsList>
          </div>
          {settingsGroups.flatMap((group) =>
            group.pages.map((page) => (
              <TabsContent
                key={page.value}
                value={page.value}
                className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto data-ending-style:hidden"
              >
                <div className="pr-2">
                  <SettingsPageBody page={page.value} project={project} reportLink={reportLink} />
                </div>
              </TabsContent>
            )),
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
