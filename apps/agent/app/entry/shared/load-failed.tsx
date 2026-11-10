import { Trans } from "@lingui/react/macro";
import { cn } from "cn";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";

/** Reads a failed list or state again. */
export function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onRetry}>
      <Trans comment="Button that loads a list or settings section again after it failed to load">
        다시 시도
      </Trans>
    </Button>
  );
}

/**
 * A list or state that could not be read, instead of showing it as empty: what failed, and a
 * button to read it again.
 */
export function LoadFailed({
  children,
  onRetry,
  className,
}: {
  /** What could not be read, as a sentence. */
  children: ReactNode;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex flex-wrap items-center gap-2 text-xs", className)}>
      <span className="min-w-0">{children}</span>
      <RetryButton onRetry={onRetry} />
    </div>
  );
}
