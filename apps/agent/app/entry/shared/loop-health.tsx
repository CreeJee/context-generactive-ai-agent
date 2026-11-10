import { Match, Predicate } from "effect";
import type { LoopHealth } from "memory-agent/definitions";
import { RotateCcwIcon } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { sharedCopy } from "./copy";

/** How a background loop the server runs stands, in words. */
export function loopHealthLabel(health: LoopHealth): string {
  return Match.valueTags(health, {
    Healthy: () => sharedCopy.loopHealth.status.Healthy,
    Retrying: ({ attempt, of }) => sharedCopy.loopHealth.status.Retrying(attempt, of),
    Exhausted: () => sharedCopy.loopHealth.status.Exhausted,
    Defected: () => sharedCopy.loopHealth.status.Defected,
  });
}

const variantOf = (health: LoopHealth) =>
  Match.valueTags(health, {
    Healthy: () => "secondary" as const,
    Retrying: () => "outline" as const,
    Exhausted: () => "destructive" as const,
    Defected: () => "destructive" as const,
  });

/**
 * A background loop's health, with a restart button once it stopped. The server owns the health
 * and announces changes; restarting asks it to run the loop again.
 */
export function LoopHealthStatus({
  label,
  health,
  disabled,
  onRestart,
}: {
  readonly label: string;
  readonly health: LoopHealth;
  readonly disabled: boolean;
  readonly onRestart: () => void;
}) {
  const stopped = Predicate.isTagged(health, "Exhausted") || Predicate.isTagged(health, "Defected");
  return (
    <span className="inline-flex items-center gap-2" role="status" aria-label={label}>
      <Badge variant={variantOf(health)}>
        {label}: {loopHealthLabel(health)}
      </Badge>
      {stopped && (
        <Button type="button" size="xs" variant="outline" disabled={disabled} onClick={onRestart}>
          <RotateCcwIcon data-icon="inline-start" />
          {sharedCopy.loopHealth.restart}
        </Button>
      )}
    </span>
  );
}
