import { useState } from "react";
import { InboxIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { DecisionPrompt } from "../chat/decision-prompt";
import { useDecisionInboxQuery } from "../queries/project";
import { koreanLocalTime } from "../shared/local-time";
import { navigationCopy } from "./copy";

/**
 * The project inbox: every card decision waiting for a person, across conversations and Goals.
 * Each one can be answered here or opened on its board.
 */
export function DecisionInbox({
  projectId,
  holder,
  onOpenCard,
}: {
  readonly projectId: string;
  readonly holder: string;
  readonly onOpenCard: (sessionId: string, cardId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const items = useDecisionInboxQuery(projectId).data ?? [];
  const copy = navigationCopy.decisionInbox;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={() => setOpen(true)}>
        <InboxIcon />
        <span>{copy.title}</span>
      </SidebarMenuButton>
      {/* Only a waiting decision asks for attention; none is the usual state. */}
      {items.length > 0 && (
        <SidebarMenuBadge>
          <Badge>{items.length}</Badge>
        </SidebarMenuBadge>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>{copy.title}</SheetTitle>
            <SheetDescription>{copy.description}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 text-xs text-muted-foreground">
            {items.length === 0 && <p>{copy.empty}</p>}
            {items.map((item) => (
              <section
                key={item.requestId}
                aria-label={copy.item(item.cardTitle)}
                className="space-y-1.5 rounded-md border p-2"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{item.cardTitle}</p>
                    <p className="truncate">
                      {item.sessionTitle ?? navigationCopy.sessions.untitled} ·{" "}
                      {koreanLocalTime(item.createdAt)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOpen(false);
                      onOpenCard(item.sessionId, item.cardId);
                    }}
                  >
                    {copy.openCard}
                  </Button>
                </div>
                <DecisionPrompt
                  projectId={projectId}
                  holder={holder}
                  request={item}
                  disabled={false}
                />
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </SidebarMenuItem>
  );
}
