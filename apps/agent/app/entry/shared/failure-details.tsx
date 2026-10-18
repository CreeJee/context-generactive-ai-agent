import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";

/**
 * The outside program's own text behind a failure, folded until asked for. The wording above it
 * comes from the failure's code; this text only helps someone look into it.
 */
export function FailureDetails({ detail }: { detail: string | null }) {
  if (detail === null) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
        자세히
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
          {detail}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
