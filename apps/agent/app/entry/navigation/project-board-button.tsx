import { KanbanSquareIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { useProjectBoardsQuery } from "../queries/project";

/** Opens the project's kanban board: every conversation's board in one view, running ones first. */
export function ProjectBoardButton({
  projectId,
  onOpen,
}: {
  readonly projectId: string;
  readonly onOpen: () => void;
}) {
  const boards = useProjectBoardsQuery(projectId).data ?? [];
  const running = boards.filter((board) => board.kanbanActive).length;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={onOpen}>
        <KanbanSquareIcon />
        <span>칸반 보드</span>
      </SidebarMenuButton>
      <SidebarMenuBadge>
        <Badge variant={running > 0 ? "default" : "secondary"}>{boards.length}</Badge>
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
}
