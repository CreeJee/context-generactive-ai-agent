import { Trans } from "@lingui/react/macro";
import { KanbanSquareIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { useProjectBoardsQuery } from "../queries/project";
import { Array as Arr } from "effect";

/** Opens the project's kanban board: every conversation's board in one view, running ones first. */
export function ProjectBoardButton({
  projectId,
  onOpen,
}: {
  readonly projectId: string;
  readonly onOpen: () => void;
}) {
  const boards = useProjectBoardsQuery(projectId).data ?? [];
  const running = Arr.countBy(boards, (board) => board.kanbanActive);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={onOpen}>
        <KanbanSquareIcon />
        <span>
          <Trans comment="Sidebar menu item that opens the project's kanban board">칸반 보드</Trans>
        </span>
      </SidebarMenuButton>
      <SidebarMenuBadge>
        <Badge variant={running > 0 ? "default" : "secondary"}>{boards.length}</Badge>
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
}
