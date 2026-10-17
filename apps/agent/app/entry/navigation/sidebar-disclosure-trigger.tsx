import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

export function SidebarDisclosureTrigger({
  children,
  leading,
  className,
  ...props
}: ComponentProps<typeof CollapsibleTrigger> & { leading?: ReactNode }) {
  return (
    <CollapsibleTrigger
      className={cn(
        "group flex min-h-10 w-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring items-center gap-2 px-3 text-left text-xs hover:bg-muted focus-visible:ring-inset",
        className,
      )}
      {...props}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronDownIcon
        aria-hidden="true"
        className="size-4 shrink-0 transition-transform group-data-[panel-open]:rotate-180"
      />
    </CollapsibleTrigger>
  );
}
