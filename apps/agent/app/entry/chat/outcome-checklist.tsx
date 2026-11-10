import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
import type { BoardView, KanbanView } from "../api";
import { Button } from "../../components/ui/button";
import { verdictText } from "./board/hold-reason";
import { WorkflowRow, WorkflowRows } from "./workflow-rows";

type BoardOutcome = BoardView["outcomes"][number];

type OutcomeTag = BoardOutcome["status"]["_tag"];

type UnjudgedOutcome = Extract<KanbanView, { readonly active: true }>["unjudgedOutcomes"][number];

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
 * once a verifier finds every one met, so this list is the Goal's progress. An outcome whose last
 * check ended without a verdict says why, and the user can ask for the check again.
 */
export function OutcomeChecklist({
  outcomes,
  unjudged = [],
  recheck,
}: {
  readonly outcomes: readonly BoardOutcome[];
  readonly unjudged?: readonly UnjudgedOutcome[];
  readonly recheck?: { readonly disabled: boolean; readonly onRecheck: () => void };
}) {
  const { t } = useLingui();
  if (outcomes.length === 0) return null;
  const unjudgedOf = (outcome: BoardOutcome) =>
    outcome.status._tag === "AwaitingCheck"
      ? (unjudged.find((entry) => entry.outcomeId === outcome.id) ?? null)
      : null;
  const stuck = outcomes.flatMap((outcome) => {
    const entry = unjudgedOf(outcome);
    return entry === null ? [] : [entry];
  });
  const noModel = stuck.some((entry) => entry.failure._tag === "ModelSelectionRequired");
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
        const entry = unjudgedOf(outcome);
        const detail = entry === null ? outcomeDetail(outcome.status) : verdictText(entry.failure);
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
      {stuck.length > 0 && (
        <li role="status" className="flex flex-wrap items-center gap-2 px-1.5 py-1">
          <span className="text-muted-foreground">
            {noModel ? (
              <Trans>
                검증할 모델이 선택되지 않아 결과를 확인하지 못했습니다. 설정의 칸반 실행에서 검증자
                모델을 고른 뒤 다시 확인해 주십시오.
              </Trans>
            ) : (
              <Trans>결과를 확인하지 못했습니다. 다시 확인할 수 있습니다.</Trans>
            )}
          </span>
          {recheck !== undefined && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={recheck.disabled}
              onClick={recheck.onRecheck}
            >
              <Trans comment="Button that checks again the outcomes whose check ended without a verdict">
                다시 확인
              </Trans>
            </Button>
          )}
        </li>
      )}
    </WorkflowRows>
  );
}
