import { Trans } from "@lingui/react/macro";
import { DateTime } from "effect";
import { TerminalIcon } from "lucide-react";
import type { RunningBackgroundTask } from "memory-agent";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "~/components/ui/item";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { backgroundKindLabel } from "../session/background-tasks";
import { duration } from "./message";

/**
 * The status-line count of this conversation's background skill runs and external-agent
 * turns that are still going; its popover lists them.
 */
export function BackgroundTaskIndicator({ tasks }: { tasks: readonly RunningBackgroundTask[] }) {
  const count = tasks.length;
  if (count === 0) return null;
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost-muted" size="xs" />}>
        <Spinner />{" "}
        <Trans comment="Status-line button: number of background tasks still running">
          백그라운드 {count}개
        </Trans>
      </PopoverTrigger>
      <PopoverContent side="top" align="start">
        <PopoverHeader>
          <PopoverTitle>
            <Trans>실행 중인 백그라운드 작업</Trans>
          </PopoverTitle>
        </PopoverHeader>
        <ItemGroup>
          {tasks.map((task) => (
            <Item key={task.id} variant="outline" size="sm">
              <ItemMedia variant="icon">
                <TerminalIcon />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="w-full">
                  <span className="min-w-0 truncate">{task.title}</span>
                </ItemTitle>
                <ItemDescription>
                  <Badge variant="outline">{backgroundKindLabel(task.kind)}</Badge>{" "}
                  {duration(now - task.startedAt)}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </PopoverContent>
    </Popover>
  );
}
