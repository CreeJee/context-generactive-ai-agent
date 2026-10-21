import { Match, Predicate } from "effect";
import type { LoopHealth } from "memory-agent/definitions";
import { RotateCcwIcon } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

/** How a background loop the server runs stands, in words. */
export function loopHealthLabel(health: LoopHealth): string {
  return Match.valueTags(health, {
    Healthy: () => "정상",
    Retrying: ({ attempt, of }) => `재시도 중 ${attempt}/${of}`,
    Exhausted: () => "재시도 소진",
    Defected: () => "결함으로 중단",
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
          다시 시작
        </Button>
      )}
    </span>
  );
}
