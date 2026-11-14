import { ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Array as Arr, Effect } from "effect";
import { ArchiveIcon, EllipsisIcon, KanbanSquareIcon, SettingsIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { refusalOf, type ListedProject } from "../api";
import { useCrossRecallMutation, useHideProjectMutation } from "../queries/mutations/project";
import { useProjectBoardsQuery } from "../queries/project";
import { errorMessage } from "../settings/shared";
import { runUiEffect, uiPromise } from "../shared/ui-effect";

/** One project's menu on its group header: its settings, kanban board, memory sharing and archive. */
export function ProjectMenu({
  project,
  onOpenBoard,
  onOpenSettings,
  onHidden,
  onProblem,
}: {
  readonly project: ListedProject;
  /** Opens the project's kanban board. */
  readonly onOpenBoard: () => void;
  /** Opens the settings on this project. */
  readonly onOpenSettings: () => void;
  /** The project left the list. */
  readonly onHidden: () => void;
  /** Why a change was refused, shown above the list. */
  readonly onProblem: (message: string) => void;
}) {
  const { t } = useLingui();
  const crossRecall = useCrossRecallMutation(project.id);
  const hide = useHideProjectMutation();
  const boards = useProjectBoardsQuery(project.id).data ?? [];
  const running = Arr.countBy(boards, (board) => board.kanbanActive);
  const busy = crossRecall.isPending || hide.isPending;
  const menuLabel = t({
    message: `${ph({ name: project.name })} 메뉴`,
    comment: "Button that opens a project's menu; name is the project's name",
  });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const allowCrossRecall = (allowed: boolean) =>
    runUiEffect(
      uiPromise(() => crossRecall.mutateAsync(!allowed)).pipe(
        Effect.catchTag("UnknownError", (failure) =>
          Effect.sync(() => onProblem(errorMessage(refusalOf(failure.cause)))),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const archive = () =>
    runUiEffect(
      uiPromise(() => hide.mutateAsync(project.id)).pipe(
        Effect.flatMap(() => Effect.sync(onHidden)),
        Effect.catchTag("UnknownError", () =>
          Effect.sync(() =>
            onProblem(t`프로젝트를 보관하지 못했습니다. 잠시 뒤 다시 시도해 주십시오.`),
          ),
        ),
      ),
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={menuLabel} title={menuLabel} />}
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start">
        <DropdownMenuItem onClick={onOpenSettings}>
          <SettingsIcon />{" "}
          <Trans comment="Menu item that opens the project's settings">프로젝트 설정</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenBoard}>
          <KanbanSquareIcon />{" "}
          <Trans comment="Menu item that opens the project's kanban board">칸반 보드</Trans>
          {boards.length > 0 && (
            <Badge className="ml-auto" variant={running > 0 ? "default" : "secondary"}>
              {boards.length}
            </Badge>
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={!project.crossRecallExcluded}
          disabled={busy}
          onCheckedChange={(checked) => void allowCrossRecall(checked)}
        >
          <Trans comment="Menu item: conversations in other projects may recall this project's memory">
            다른 프로젝트가 이 기억을 찾도록 허용
          </Trans>
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem disabled={busy} onClick={() => void archive()}>
          <ArchiveIcon /> <Trans comment="Menu item that archives the project">프로젝트 보관</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
