import type { ReactNode } from "react";
import { useSidebar } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";

/** The open conversation's name and project, with the panels that open beside it. */
export function ChatHeader({
  title,
  projectName,
  children,
}: {
  readonly title: string;
  readonly projectName: string | null;
  /** The buttons at the header's end: BTW and Work Trace. */
  readonly children: ReactNode;
}) {
  const { open, isMobile } = useSidebar();
  return (
    <header
      className={cn(
        "flex h-11 shrink-0 items-center gap-2 border-b px-4",
        // The button that reopens a folded sidebar sits over the header's start.
        (!open || isMobile) && "pl-12",
      )}
    >
      <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
      {projectName !== null && (
        <span className="shrink-0 truncate text-xs text-muted-foreground">{projectName}</span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">{children}</div>
    </header>
  );
}
