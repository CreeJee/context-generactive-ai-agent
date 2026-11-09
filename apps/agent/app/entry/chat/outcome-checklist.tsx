import { Array as Arr, Match } from "effect";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleXIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import type { BoardView } from "../api";

type BoardOutcome = BoardView["outcomes"][number];
type OutcomeTag = BoardOutcome["status"]["_tag"];

/** How each outcome status reads on the page. */
const outcomeLooks: Readonly<
  Record<
    OutcomeTag,
    { readonly icon: LucideIcon; readonly label: string; readonly className: string }
  >
> = {
  Unplanned: { icon: CircleIcon, label: "맡은 카드 없음", className: "text-muted-foreground" },
  InProgress: { icon: CircleDotIcon, label: "진행 중", className: "text-warning" },
  AwaitingCheck: { icon: CircleDashedIcon, label: "확인 대기", className: "text-info" },
  Met: { icon: CircleCheckIcon, label: "충족", className: "text-success" },
  NotMet: { icon: CircleXIcon, label: "미충족", className: "text-destructive" },
};

/** What the status adds after its label: the cards left, or the verifier's verdict. */
const verdictOf = ({ summary }: { readonly summary: string }) =>
  summary.length > 0 ? summary : null;
const outcomeDetail = (status: BoardOutcome["status"]): string | null =>
  Match.valueTags(status, {
    Unplanned: () => null,
    InProgress: ({ pending }) => `카드 ${pending.length}개 남음`,
    AwaitingCheck: ({ stale }) => (stale ? "바뀐 뒤 다시 확인해요" : null),
    Met: verdictOf,
    NotMet: verdictOf,
  });

/**
 * The Goal's outcomes and where each stands. The Goal is done once a verifier finds every one
 * met, so this list is the Goal's progress.
 */
export function OutcomeChecklist({ outcomes }: { readonly outcomes: readonly BoardOutcome[] }) {
  if (outcomes.length === 0) return null;
  const met = Arr.countBy(outcomes, (outcome) => outcome.status._tag === "Met");
  return (
    <section aria-label="Goal 결과" className="flex flex-col gap-1.5">
      <p className="text-xs font-medium">
        결과 {met}/{outcomes.length} 충족
      </p>
      <ItemGroup>
        {outcomes.map((outcome) => {
          const look = outcomeLooks[outcome.status._tag];
          const detail = outcomeDetail(outcome.status);
          return (
            <Item key={outcome.id} role="listitem" variant="muted" size="xs">
              <ItemMedia variant="icon">
                <look.icon aria-hidden className={look.className} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle title={outcome.text}>{outcome.text}</ItemTitle>
                <ItemDescription>
                  {outcome.id} · {look.label}
                  {detail !== null && ` · ${detail}`}
                </ItemDescription>
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
    </section>
  );
}
