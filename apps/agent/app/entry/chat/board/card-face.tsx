import { isTruthy } from "../../../truthy.ts";
import {
  BanIcon,
  BotIcon,
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

/** Who last changed the card, as a small avatar with the name and time as its label. */
export function AuthorAvatar({ change }: { readonly change: BoardCard["lastChange"] }) {
  const label =
    change === null
      ? "마지막 변경 기록 없음"
      : `마지막 변경: ${authorLabel(change.author)} · ${koreanLocalTime(change.at)}`;
  const Icon = Predicate.isTagged(change?.author, "Orchestrator") ? BotIcon : UserRoundIcon;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "ml-auto grid size-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground",
        change === null && "opacity-40",
      )}
    >
      <Icon aria-hidden className="size-3" />
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
  /** Titles of the cards it depends on that are not done yet. */
  readonly waitingOn: readonly string[];
  /** The conversation the card belongs to, when the board shows several Plans. */
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
  const { card } = entry;
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
        <AuthorAvatar change={entry.lastChange} />
      </span>
      {signals.reason !== null && (
        <span className="mt-1.5 line-clamp-2 block text-2xs text-muted-foreground">
          {signals.reason}
        </span>
      )}
    </>
  );
}
