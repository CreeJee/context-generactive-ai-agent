import { isTruthy } from "../../../truthy.ts";
import {
  BanIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleIcon,
  CirclePauseIcon,
  HourglassIcon,
  LinkIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import { Match, Predicate } from "effect";
import type { BoardAuthor, CardRisk } from "memory-agent";
import { Badge } from "../../../components/ui/badge";
import { Spinner } from "../../../components/ui/spinner";
import type { BoardView, CardStatus } from "../../api";
import { koreanLocalTime } from "../../shared/local-time";
import { cardStatusLabels } from "./board-moves";

type BoardCard = BoardView["cards"][number];

const statusIcons: Readonly<Record<CardStatus, { icon: LucideIcon; className: string }>> = {
  backlog: { icon: CircleDashedIcon, className: "text-muted-foreground" },
  ready: { icon: CircleIcon, className: "text-foreground/70" },
  in_progress: { icon: CircleDotIcon, className: "text-warning" },
  verify: { icon: CircleDotDashedIcon, className: "text-primary" },
  human_decision: { icon: CircleHelpIcon, className: "text-warning" },
  done: { icon: CircleCheckIcon, className: "text-primary" },
  blocked: { icon: BanIcon, className: "text-destructive" },
};

export function StatusIcon({
  status,
  className,
}: {
  readonly status: CardStatus;
  readonly className?: string;
}) {
  const { icon: Icon, className: tone } = statusIcons[status];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", tone, className)} />;
}

export const riskLabels: Readonly<Record<CardRisk, string>> = {
  low: "위험 낮음",
  medium: "위험 보통",
  high: "위험 높음",
};

export function authorLabel(author: BoardAuthor | null): string {
  if (author === null) return "기록 없음";
  return Match.valueTags(author, { User: () => "사용자", Orchestrator: () => "오케스트레이터" });
}

/**
 * Marks a card the user changed last, with the time as its label. The orchestrator moving cards is
 * the board's normal course, so its changes are only in the peek.
 */
export function UserChangeMark({ at }: { readonly at: string }) {
  const label = `마지막 변경: 사용자 · ${koreanLocalTime(at)}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="ml-auto grid size-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
    >
      <UserRoundIcon aria-hidden className="size-3" />
    </span>
  );
}

/** What else the card shows besides its title: what it waits for and why the loop held it. */
export interface CardSignals {
  readonly decisionPending: boolean;
  readonly changePending: boolean;
  /** A request about the card is on its way; the card shows where it is expected to land. */
  readonly requesting: boolean;
  readonly reason: string | null;
  /** Titles of the unfinished cards it depends on, while it has not started. */
  readonly waitingOn: readonly string[];
  /** The conversation the card belongs to, when the board shows cards of several Plans. */
  readonly group: string | null;
}

/** A card's compact face, shared by the board and the card being dragged. */
export function CardFace({
  entry,
  signals,
}: {
  readonly entry: BoardCard;
  readonly signals: CardSignals;
}) {
  const { card, lastChange } = entry;
  const userChangedAt =
    lastChange !== null && Predicate.isTagged(lastChange.author, "User") ? lastChange.at : null;
  const meta =
    isTruthy(card.risk) ||
    signals.decisionPending ||
    card.hold !== undefined ||
    signals.requesting ||
    signals.changePending ||
    signals.waitingOn.length > 0 ||
    userChangedAt !== null;
  return (
    <>
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <StatusIcon status={card.status} />
        <span className="shrink-0 font-mono">{card.id}</span>
        <span className="sr-only">{cardStatusLabels[card.status]}</span>
        {signals.group !== null && (
          <span className="truncate" title={signals.group}>
            · {signals.group}
          </span>
        )}
      </span>
      <span className="mt-1 line-clamp-2 block text-xs font-medium text-foreground">
        {card.title}
      </span>
      {meta && (
        <span className="mt-2 flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
          {isTruthy(card.risk) && <Badge variant="outline">{riskLabels[card.risk]}</Badge>}
          {signals.decisionPending && (
            <Badge variant="outline">
              <HourglassIcon data-icon="inline-start" />
              판단 대기
            </Badge>
          )}
          {card.hold !== undefined && (
            <Badge variant="secondary">
              <CirclePauseIcon data-icon="inline-start" />
              보류
            </Badge>
          )}
          {signals.requesting && (
            <Badge variant="outline">
              <Spinner data-icon="inline-start" />
              요청 중
            </Badge>
          )}
          {signals.changePending && <Badge variant="outline">변경 요청 대기</Badge>}
          {signals.waitingOn.length > 0 && (
            <span className="inline-flex items-center gap-0.5" title={signals.waitingOn.join(", ")}>
              <LinkIcon aria-hidden className="size-3" />
              선행 {signals.waitingOn.length}
            </span>
          )}
          {userChangedAt !== null && <UserChangeMark at={userChangedAt} />}
        </span>
      )}
      {signals.reason !== null && (
        <span className="mt-1.5 line-clamp-2 block text-2xs text-muted-foreground">
          {signals.reason}
        </span>
      )}
    </>
  );
}
