import { Array as Arr, Match } from "effect";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleXIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import type { BoardView } from "../api";
import { WorkflowRow, WorkflowRows } from "./workflow-rows";

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
  AwaitingCheck: { icon: CircleDashedIcon, label: "확인 대기", className: "text-foreground/70" },
  Met: { icon: CircleCheckIcon, label: "충족", className: "text-primary" },
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

/** How many outcomes a verifier found met: the Goal's progress. */
export const metOutcomes = (outcomes: readonly BoardOutcome[]): number =>
  Arr.countBy(outcomes, (outcome) => outcome.status._tag === "Met");

/**
 * The Goal's outcomes, one line each, under a heading that counts the met ones. The Goal is done
 * once a verifier finds every one met, so this list is the Goal's progress.
 */
export function OutcomeChecklist({ outcomes }: { readonly outcomes: readonly BoardOutcome[] }) {
  if (outcomes.length === 0) return null;
  return (
    <WorkflowRows label={`결과 ${metOutcomes(outcomes)}/${outcomes.length} 충족`}>
      {outcomes.map((outcome) => {
        const look = outcomeLooks[outcome.status._tag];
        const detail = outcomeDetail(outcome.status);
        const status = detail === null ? look.label : `${look.label} · ${detail}`;
        return (
          <WorkflowRow
            key={outcome.id}
            title={`${outcome.id} ${outcome.text}\n${status}`}
            icon={<look.icon aria-hidden className={cn("size-3.5", look.className)} />}
            trailing={<span className={look.className}>{status}</span>}
          >
            {outcome.text}
          </WorkflowRow>
        );
      })}
    </WorkflowRows>
  );
}
