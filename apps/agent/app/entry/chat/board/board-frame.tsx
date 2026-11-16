import type { ReactNode } from "react";
import { Trans } from "@lingui/react/macro";
import { XIcon } from "lucide-react";
import { Button } from "../../../components/ui/button";

/**
 * A board in the page's main area: a title row with the board's tools and its close button, the
 * board's status below it, and the board itself filling the rest. It is not a dialog, so the
 * sidebar and the rest of the page stay usable beside it.
 */
export function BoardFrame({
  title,
  leading,
  tools,
  header,
  onEscape,
  onClose,
  children,
}: {
  readonly title: string;
  /** Drawn before the title; the page leaves room there for the button that reopens the sidebar. */
  readonly leading?: ReactNode;
  /** Drawn on the title row before the close button. */
  readonly tools?: ReactNode;
  /** The board's status and actions, under the title. */
  readonly header: ReactNode;
  /** Esc pressed inside the board; the board decides what it closes. */
  readonly onEscape: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex h-full min-h-0 flex-col gap-4 text-xs/relaxed"
      onKeyDown={(event) => {
        // A dialog or menu opened from the board is drawn elsewhere in the page; its Esc is its own.
        if (event.key !== "Escape") return;
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        onEscape();
      }}
    >
      <header className="flex flex-col gap-1 border-b p-4">
        <div className="flex items-center gap-2">
          {leading}
          <h2 className="font-heading text-sm font-medium">{title}</h2>
          <span className="ml-auto flex items-center gap-1">
            {tools}
            <Button type="button" size="sm" variant="outline" onClick={onClose}>
              <XIcon data-icon="inline-start" />
              <Trans comment="Button that closes the kanban board and shows the conversation again">
                보드 닫기
              </Trans>
            </Button>
          </span>
        </div>
        {header}
      </header>
      {children}
    </section>
  );
}
