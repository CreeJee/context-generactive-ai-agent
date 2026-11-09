import type { ReactElement, ReactNode } from "react";
import { useRender } from "@base-ui/react/use-render";

/**
 * A titled list of one-line rows in the workflow bar. Rows stay one line high so a Plan of many
 * cards reads at a glance; the full text is in each row's title.
 */
export function WorkflowRows({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-0.5">
      <p className="px-1.5 text-2xs font-medium text-muted-foreground">{label}</p>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

/** One line: an icon, the text cut to the width, and a short status at the end. */
export function WorkflowRow({
  icon,
  trailing,
  title,
  render,
  children,
}: {
  readonly icon: ReactNode;
  readonly trailing?: ReactNode;
  readonly title?: string;
  /** Renders the row as a link or button; hovering then marks it. */
  readonly render?: ReactElement;
  readonly children: ReactNode;
}) {
  const row = useRender({
    defaultTagName: "div",
    render,
    props: {
      title,
      className:
        "flex h-6 min-w-0 items-center gap-2 rounded-md px-1.5 text-xs [a]:transition-colors [a]:hover:bg-muted/60",
      children: (
        <>
          <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
          <span className="min-w-0 flex-1 truncate">{children}</span>
          {trailing !== undefined && (
            <span className="max-w-1/2 shrink-0 truncate text-2xs text-muted-foreground">
              {trailing}
            </span>
          )}
        </>
      ),
    },
  });
  return <li className="min-w-0">{row}</li>;
}
