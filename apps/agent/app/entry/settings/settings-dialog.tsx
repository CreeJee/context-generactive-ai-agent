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

const settingsGroups = [
  {
    label: "연결",
    pages: [
      { value: "web", label: "웹 검색", icon: GlobeIcon },
      { value: "image", label: "이미지 생성", icon: ImageIcon },
      { value: "mcp", label: "MCP 서버", icon: PlugIcon },
      { value: "agents", label: "외부 에이전트", icon: BotIcon },
    ],
  },
  {
    label: "기억",
    pages: [
      { value: "conversation", label: "긴 대화", icon: MessagesSquareIcon },
      { value: "recall", label: "기억 범위", icon: WaypointsIcon },
      { value: "imports", label: "대화 가져오기", icon: HistoryIcon },
      { value: "embedding", label: "임베딩", icon: CpuIcon },
    ],
  },
  { label: "실행", pages: [{ value: "kanban", label: "칸반 실행", icon: KanbanIcon }] },
  {
    label: "개선",
    pages: [{ value: "improvements", label: "프로젝트 개선", icon: WrenchIcon }],
  },
  { label: "지침", pages: [{ value: "skills", label: "Skills", icon: BookOpenIcon }] },
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
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>대화 밖에서 쓰는 도구와 연결을 관리해요.</DialogDescription>
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
