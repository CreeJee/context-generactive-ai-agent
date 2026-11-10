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
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { type Project } from "../api";
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
import { settingsCopy } from "./copy";

const { groups } = settingsCopy.dialog;
const { titles } = settingsCopy;

const settingsGroups = [
  {
    label: groups.connection,
    pages: [
      { value: "web", label: titles.web, icon: GlobeIcon },
      { value: "image", label: titles.image, icon: ImageIcon },
      { value: "mcp", label: titles.mcp, icon: PlugIcon },
      { value: "agents", label: titles.agents, icon: BotIcon },
    ],
  },
  {
    label: groups.memory,
    pages: [
      { value: "conversation", label: titles.conversation, icon: MessagesSquareIcon },
      { value: "recall", label: titles.recall, icon: WaypointsIcon },
      { value: "imports", label: titles.imports, icon: HistoryIcon },
      { value: "embedding", label: titles.embedding, icon: CpuIcon },
    ],
  },
  { label: groups.run, pages: [{ value: "kanban", label: titles.kanban, icon: KanbanIcon }] },
  {
    label: groups.improvement,
    pages: [{ value: "improvements", label: titles.improvements, icon: WrenchIcon }],
  },
  {
    label: groups.instructions,
    pages: [{ value: "skills", label: titles.skills, icon: BookOpenIcon }],
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
  project: Project | null;
  initialPage?: SettingsPage;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex h-[min(40rem,calc(100dvh-2rem))] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{settingsCopy.dialog.title}</DialogTitle>
          <DialogDescription>{settingsCopy.dialog.description}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={initialPage} orientation="vertical" className="min-h-0 flex-1">
          <div className="mr-2 w-40 shrink-0 border-r pr-3">
            <TabsList variant="nav" className="w-full items-stretch justify-start">
              {settingsGroups.map((group) => (
                <div key={group.label} className="flex flex-col gap-0.5 not-first:pt-3">
                  <div className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                    {group.label}
                  </div>
                  {group.pages.map((page) => (
                    <TabsTrigger key={page.value} value={page.value}>
                      <page.icon />
                      {page.label}
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
