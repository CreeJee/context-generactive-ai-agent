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
  WaypointsIcon,
  WrenchIcon,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { type ListedProject, type Project } from "../api";
import { MissingFolderNotice } from "../navigation/sidebar";
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
import { SkillSettings } from "./pages/skills";
import { ImprovementSettings } from "./pages/improvements";
import { KanbanSettings } from "./pages/kanban";
import { pageTitles } from "./shared";

const settingsGroups = [
  {
    id: "connection",
    label: msg({ message: "연결", comment: "Settings tab group: web, image, MCP and agent pages" }),
    pages: [
      { value: "web", icon: GlobeIcon },
      { value: "image", icon: ImageIcon },
      { value: "mcp", icon: PlugIcon },
      { value: "agents", icon: BotIcon },
    ],
  },
  {
    id: "memory",
    label: msg({
      message: "기억",
      comment: "Settings tab group: pages about the app's stored conversation memory",
    }),
    pages: [
      { value: "conversation", icon: MessagesSquareIcon },
      { value: "recall", icon: WaypointsIcon },
      { value: "imports", icon: HistoryIcon },
      { value: "embedding", icon: CpuIcon },
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
  {
    id: "improvement",
    label: msg({ message: "개선", comment: "Settings tab group: project improvement reports" }),
    pages: [{ value: "improvements", icon: WrenchIcon }],
  },
  {
    id: "instructions",
    label: msg({
      message: "지침",
      comment: "Settings tab group: skill instructions for the model",
    }),
    pages: [{ value: "skills", icon: BookOpenIcon }],
  },
] as const;

type SettingsPage = (typeof settingsGroups)[number]["pages"][number]["value"];

/** Each page's body; every page reads its own data, so each gets its own loading boundary. */
const pageBodies: Record<SettingsPage, (project: Project | null) => ReactNode> = {
  improvements: () => <ImprovementSettings />,
  web: () => <KagiSettings />,
  image: () => <ImageSettings />,
  mcp: (project) => <McpSettings project={project} />,
  agents: (project) => <AgentSettings project={project} />,
  conversation: () => <ConversationSettings />,
  recall: () => <RecallSettings />,
  imports: () => <ImportSettings />,
  embedding: () => <EmbeddingSettings />,
  skills: (project) => <SkillSettings project={project} />,
  kanban: (project) => <KanbanSettings project={project} />,
};

function SettingsPageBody({ page, project }: { page: SettingsPage; project: Project | null }) {
  return <QuerySection>{pageBodies[page](project)}</QuerySection>;
}

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
  project,
  open,
  onClose,
  initialPage = "web",
}: {
  project: ListedProject | null;
  initialPage?: SettingsPage;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
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
        {project?.folderMissing === true && (
          <MissingFolderAlert project={project} onArchived={onClose} />
        )}
        <Tabs defaultValue={initialPage} orientation="vertical" className="min-h-0 flex-1">
          <div className="mr-2 w-40 shrink-0 border-r pr-3">
            <TabsList variant="nav" className="w-full items-stretch justify-start">
              {settingsGroups.map((group) => (
                <div key={group.id} className="flex flex-col gap-0.5 not-first:pt-3">
                  <div className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                    {t(group.label)}
                  </div>
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
                  <SettingsPageBody page={page.value} project={project} />
                </div>
              </TabsContent>
            )),
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
