import { TerminalIcon } from "lucide-react";
import type { TraceTaskView } from "memory-agent";
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
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { backgroundKindLabel, runningBackgroundTasks } from "../session/background-tasks";
import { chatCopy } from "./copy";
import { elapsed } from "./message";

const openInWorkTrace = (taskId: string) =>
  window.dispatchEvent(new CustomEvent("work-trace:open", { detail: { taskId } }));

/**
 * The status-line count of this conversation's background shell commands and external-agent
 * turns that are still going; its popover lists them, and each opens in Work Trace.
 */
export function BackgroundTaskIndicator({ tasks }: { tasks: readonly TraceTaskView[] }) {
  const running = runningBackgroundTasks(tasks);
  if (running.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost-muted" size="xs" />}>
        <Spinner /> {chatCopy.backgroundTasks.trigger(running.length)}
      </PopoverTrigger>
      <PopoverContent side="top" align="start">
        <PopoverHeader>
          <PopoverTitle>{chatCopy.backgroundTasks.title}</PopoverTitle>
          <PopoverDescription>{chatCopy.backgroundTasks.description}</PopoverDescription>
        </PopoverHeader>
        <ItemGroup>
          {running.map((task) => (
            <Item
              key={task.id}
              variant="outline"
              size="sm"
              render={<button type="button" className="text-left" />}
              onClick={() => openInWorkTrace(task.id)}
            >
              <ItemMedia variant="icon">
                <TerminalIcon />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="w-full">
                  <span className="min-w-0 truncate">{task.title || task.request}</span>
                </ItemTitle>
                <ItemDescription>
                  <Badge variant="outline">{backgroundKindLabel(task)}</Badge> {elapsed(task)}
                  {task.heartbeat?.step && ` · ${task.heartbeat.step}`}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </PopoverContent>
    </Popover>
  );
}
