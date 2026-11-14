import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Match, Predicate } from "effect";
import { Badge } from "../../../components/ui/badge";
import type { GoalMergeState } from "../../api";
import { verdictText } from "./hold-reason";

/** A pull request address as a link target; only a web address is one. */
const pullRequestLink = (url: string) => (url.startsWith("https://") ? url : null);

/** Why the scheduler stopped merging a Goal on its own. */
const stoppedMergeTexts = {
  no_target: msg`detached HEAD에서 시작해 브랜치가 없으므로 자동 merge하지 않습니다`,
  target_missing: msg`대상 브랜치가 없어졌습니다`,
  conflict_stopped: msg`충돌로 자동 merge를 멈췄습니다`,
  goal_replaced: msg`Goal 변경으로 merge를 멈췄습니다`,
} satisfies Record<
  Extract<GoalMergeState, { readonly _tag: "Stopped" }>["reason"],
  MessageDescriptor
>;

/** Where a Goal's merge into its target stands, in words. */
export function mergeStateLabel(state: GoalMergeState | null): MessageDescriptor {
  if (state === null) return msg`카드가 모두 끝난 뒤 merge합니다`;
  return Match.valueTags(state, {
    ResolvingConflict: ({ files }) => {
      const count = files.length;
      return msg`대상 브랜치와 충돌한 파일 ${count}개를 에이전트가 해결하는 중`;
    },
    Verifying: () => msg`Goal 전체를 검증하는 중`,
    VerifyFailed: ({ verdict: failure }) => {
      const verdict = verdictText(failure);
      return msg`Goal 검증 실패: ${verdict}`;
    },
    WaitingWorktree: ({ worktree }) =>
      msg`작업 트리에 커밋하지 않은 변경이 있어 기다리는 중 (${worktree})`,
    TargetMoving: () => msg`대상 브랜치가 계속 바뀌어 다시 시도할 예정`,
    AwaitingDecision: () => msg`사람의 판단을 기다리는 중`,
    Merged: ({ commit: full }) => {
      const commit = full.slice(0, 8);
      return msg`merge됨 (${commit})`;
    },
    ManualMerge: () => msg`직접 merge하기로 함, Goal 브랜치를 남겨 둠`,
    PullRequestPending: () => msg`PR을 만드는 중`,
    PullRequestCreated: ({ url }) =>
      pullRequestLink(url) === null ? msg`PR을 만듦: ${url}` : msg`PR을 만듦`,
    PullRequestUncertain: () =>
      msg`PR을 만들던 중 멈췄습니다. 원격 저장소에서 직접 확인해 주십시오`,
    PullRequestFailed: ({ stage }) =>
      stage === "push" ? msg`Goal 브랜치 push 실패` : msg`PR 생성 실패`,
    Stopped: ({ reason }) => stoppedMergeTexts[reason],
  });
}

const mergeTone = (state: GoalMergeState) =>
  Match.valueTags(state, {
    Merged: () => "secondary" as const,
    ManualMerge: () => "secondary" as const,
    PullRequestCreated: () => "secondary" as const,
    ResolvingConflict: () => "outline" as const,
    Verifying: () => "outline" as const,
    WaitingWorktree: () => "outline" as const,
    TargetMoving: () => "outline" as const,
    AwaitingDecision: () => "outline" as const,
    PullRequestPending: () => "outline" as const,
    VerifyFailed: () => "destructive" as const,
    PullRequestUncertain: () => "destructive" as const,
    PullRequestFailed: () => "destructive" as const,
    Stopped: () => "destructive" as const,
  });

/** Whether the Goal's merge ended in a state only a person can move on from. */
export const mergeFailed = (state: GoalMergeState | null) =>
  state !== null && mergeTone(state) === "destructive";

/** Where a Goal's merge stands, as a badge; a created pull request also gets its link. */
export function GoalMergeStatus({ merge }: { readonly merge: GoalMergeState }) {
  const { t } = useLingui();
  const link = Predicate.isTagged(merge, "PullRequestCreated") ? pullRequestLink(merge.url) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" role="status">
      <Badge variant={mergeTone(merge)}>{t(mergeStateLabel(merge))}</Badge>
      {link !== null && (
        <a href={link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          <Trans comment="Link that opens the Goal's pull request in a new tab">PR 열기</Trans>
        </a>
      )}
    </span>
  );
}
