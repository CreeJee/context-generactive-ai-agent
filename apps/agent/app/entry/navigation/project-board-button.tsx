import { KanbanSquareIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
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
    <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" onClick={onOpen}>
      <KanbanSquareIcon />
      칸반 보드
      <Badge variant={running > 0 ? "default" : "secondary"} className="ml-auto">
        {boards.length}
      </Badge>
    </Button>
  );
}
