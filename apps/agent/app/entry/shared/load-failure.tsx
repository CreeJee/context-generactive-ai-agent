import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { cn } from "cn";
import { Button } from "~/components/ui/button";

/**
 * A part of the page whose query failed to load: what did not load and a button that loads it
 * again, as a settings section that failed to load reads (`QuerySection`).
 */
export function LoadFailure({
  children,
  onRetry,
  className,
}: {
  readonly children: ReactNode;
  readonly onRetry: () => void;
  readonly className?: string;
}) {
  return (
    <div role="alert" className={cn("flex items-center gap-3 text-sm", className)}>
      <span>{children}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <Trans comment="Button that loads a part of the page again after it failed to load">
          다시 시도
        </Trans>
      </Button>
    </div>
  );
}
