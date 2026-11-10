import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
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
    { readonly icon: LucideIcon; readonly label: MessageDescriptor; readonly className: string }
  >
> = {
  Unplanned: {
    icon: CircleIcon,
    label: msg({ message: "맡은 카드 없음", comment: "Goal outcome status: no card works on it" }),
    className: "text-muted-foreground",
  },
  InProgress: {
    icon: CircleDotIcon,
    label: msg({
      message: "진행 중",
      comment: "Goal outcome status: its cards are being worked on",
    }),
    className: "text-warning",
  },
  AwaitingCheck: {
    icon: CircleDashedIcon,
    label: msg({
      message: "확인 대기",
      comment: "Goal outcome status: waiting for a verifier to check it",
    }),
    className: "text-foreground/70",
  },
  Met: {
    icon: CircleCheckIcon,
    label: msg({ message: "충족", comment: "Goal outcome status: a verifier found it met" }),
    className: "text-primary",
  },
  NotMet: {
    icon: CircleXIcon,
    label: msg({ message: "미충족", comment: "Goal outcome status: a verifier found it not met" }),
    className: "text-destructive",
  },
};

const verdictOf = ({ summary }: { readonly summary: string }) =>
  summary.length > 0 ? summary : null;

/** How many outcomes a verifier found met: the Goal's progress. */
export const metOutcomes = (outcomes: readonly BoardOutcome[]): number =>
  Arr.countBy(outcomes, (outcome) => outcome.status._tag === "Met");

/**
 * The Goal's outcomes, one line each, under a heading that counts the met ones. The Goal is done
 * once a verifier finds every one met, so this list is the Goal's progress.
 */
export function OutcomeChecklist({ outcomes }: { readonly outcomes: readonly BoardOutcome[] }) {
  const { t } = useLingui();
  if (outcomes.length === 0) return null;
  /** What the status adds after its label: the cards left, or the verifier's verdict. */
  const outcomeDetail = (status: BoardOutcome["status"]): string | null =>
    Match.valueTags(status, {
      Unplanned: () => null,
      InProgress: ({ pending }) => t`카드 ${ph({ count: pending.length })}개 남음`,
      AwaitingCheck: ({ stale }) => (stale ? t`바뀐 뒤 다시 확인합니다` : null),
      Met: verdictOf,
      NotMet: verdictOf,
    });
  return (
    <WorkflowRows
      label={t`결과 ${ph({ met: metOutcomes(outcomes) })}/${ph({ total: outcomes.length })} 충족`}
    >
      {outcomes.map((outcome) => {
        const look = outcomeLooks[outcome.status._tag];
        const label = t(look.label);
        const detail = outcomeDetail(outcome.status);
        const status = detail === null ? label : `${label} · ${detail}`;
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
