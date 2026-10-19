import type { LoopHealth } from "memory-agent/definitions";
import { RotateCcwIcon } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

/** How a background loop the server runs stands, in words. */
export function loopHealthLabel(health: LoopHealth): string {
  switch (health._tag) {
    case "Healthy":
      return "정상";
    case "Retrying":
      return `재시도 중 ${health.attempt}/${health.of}`;
    case "Exhausted":
      return "재시도 소진";
    case "Defected":
      return "결함으로 중단";
  }
}

const variantOf = (health: LoopHealth) => {
  switch (health._tag) {
    case "Healthy":
      return "secondary" as const;
    case "Retrying":
      return "outline" as const;
    case "Exhausted":
    case "Defected":
      return "destructive" as const;
  }
};

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
  const stopped = health._tag === "Exhausted" || health._tag === "Defected";
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
