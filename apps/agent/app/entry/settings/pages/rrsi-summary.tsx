import { Option, Schema } from "effect";
import { isTruthy } from "../../../truthy.ts";
import type { ExperimentRecord, HarnessVersion } from "memory-agent";
import { FieldDescription } from "~/components/ui/field";

type CandidateRecord = ExperimentRecord["candidates"][number];
const Profile = Schema.Struct({
  rolePrompt: Schema.String,
  memoryToolDescription: Schema.String,
  retrievalLeadLimit: Schema.Number,
  retrievalTokenLimit: Schema.Number,
});
const ProfileDiff = Schema.fromJsonString(Schema.Struct({ before: Profile, after: Profile }));

/** Rounds can hold several candidates, so each one is named by its order within the round. */
export function candidateLabel(candidates: readonly CandidateRecord[], index: number) {
  const candidate = candidates[index];
  switch (candidate.kind) {
    case "code":
      return "코드 후보";
    case "profile": {
      const order = candidates
        .slice(0, index)
        .filter(
          (earlier) => earlier.kind === "profile" && earlier.round === candidate.round,
        ).length;
      return `라운드 ${candidate.round + 1} · 후보 ${order + 1}`;
    }
  }
}

function TextChange({ label, before, after }: { label: string; before: string; after: string }) {
  if (before === after) return null;
  const change = before === "" ? "추가" : after === "" ? "삭제" : "변경";
  return (
    <li>
      {label} {change}
      {after !== "" && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{after}</p>}
    </li>
  );
}

/** A profile candidate's changes as sentences; the raw JSON stays only as a fallback. */
function ProfileChanges({ diff }: { diff: string }) {
  const parsed = Schema.decodeUnknownOption(ProfileDiff)(diff);
  if (Option.isNone(parsed))
    return <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{diff}</pre>;
  const { before, after } = parsed.value;
  const unchanged =
    before.retrievalLeadLimit === after.retrievalLeadLimit &&
    before.retrievalTokenLimit === after.retrievalTokenLimit &&
    before.rolePrompt === after.rolePrompt &&
    before.memoryToolDescription === after.memoryToolDescription;
  if (unchanged) return <p>바뀐 설정이 없어요.</p>;
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5">
      {before.retrievalLeadLimit !== after.retrievalLeadLimit && (
        <li>
          기억 검색 개수 {before.retrievalLeadLimit}개 → {after.retrievalLeadLimit}개
        </li>
      )}
      {before.retrievalTokenLimit !== after.retrievalTokenLimit && (
        <li>
          기억 검색 길이 {before.retrievalTokenLimit}토큰 → {after.retrievalTokenLimit}토큰
        </li>
      )}
      <TextChange label="추가 작업 지침" before={before.rolePrompt} after={after.rolePrompt} />
      <TextChange
        label="기억 검색 도구의 추가 안내"
        before={before.memoryToolDescription}
        after={after.memoryToolDescription}
      />
    </ul>
  );
}

/** Code candidates keep their branch and commit for review; profile candidates only need the change. */
export function CandidateDetails({ candidate }: { candidate: CandidateRecord }) {
  switch (candidate.kind) {
    case "profile":
      return (
        <details className="text-sm">
          <summary className="cursor-pointer">변경 내용 보기</summary>
          <div className="mt-2">
            <ProfileChanges diff={candidate.diff} />
          </div>
        </details>
      );
    case "code":
      return (
        <>
          <details className="text-sm">
            <summary className="cursor-pointer">변경 내용 보기</summary>
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{candidate.diff}</pre>
          </details>
          {candidate.branch && <code>{candidate.branch}</code>}
          {candidate.commit && <code>commit: {candidate.commit}</code>}
          {candidate.imageId && <code>artifact: {candidate.imageId}</code>}
          {candidate.decision === "code_review_pending" && (
            <FieldDescription>
              평가를 통과한 후보예요. 위 diff와 커밋을 검토한 뒤 별도 브랜치에서 반영하세요.
            </FieldDescription>
          )}
        </>
      );
  }
}

export const phaseLabels = {
  baseline: "현재 설정 평가",
  proposal: "개선 후보 만들기",
  critique: "후보 검토",
  candidate_evaluation: "개선 후보 평가",
  validation: "별도 과제로 개선 효과 확인",
  sealed: "최종 검증",
  code_proposal: "코드 변경 후보 만들기",
  code_build: "코드 후보 빌드와 검사",
  code_validation: "코드 후보 평가",
  finished: "평가 종료",
};
export const statusLabels = {
  running: "평가 중",
  completed: "평가 종료",
  failed: "평가 실패",
  cancelled: "평가 중단",
};

export function AppliedSettings({
  current,
  versions,
}: {
  current: HarnessVersion;
  versions: HarnessVersion[];
}) {
  const previous = versions.find((version) => version.id === current.parentId);
  return (
    <section className="flex flex-col gap-2" aria-label="적용된 설정">
      <h4 className="text-sm font-medium">지금 무엇이 달라졌나요?</h4>
      <p className="text-sm">
        {current.id === "baseline"
          ? "아직 적용된 개선이 없어요. 기본 설정을 사용하고 있어요."
          : "검증을 통과한 설정을 새 Goal에 적용하고 있어요."}
      </p>
      {current.profile && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 break-words text-sm">
          <dt>기억 검색 개수</dt>
          <dd>
            {isTruthy(previous) &&
            previous.profile.retrievalLeadLimit !== current.profile.retrievalLeadLimit
              ? `${previous.profile.retrievalLeadLimit}개 → `
              : ""}
            {current.profile.retrievalLeadLimit}개
          </dd>
          <dt>기억 검색 길이</dt>
          <dd>
            {isTruthy(previous) &&
            previous.profile.retrievalTokenLimit !== current.profile.retrievalTokenLimit
              ? `${previous.profile.retrievalTokenLimit}토큰 → `
              : ""}
            {current.profile.retrievalTokenLimit}토큰
          </dd>
          <dt>추가 작업 지침</dt>
          <dd>{current.profile.rolePrompt || "없음"}</dd>
          <dt>기억 검색 도구의 추가 안내</dt>
          <dd>{current.profile.memoryToolDescription || "없음"}</dd>
        </dl>
      )}
      {previous && (
        <details className="text-sm">
          <summary className="cursor-pointer">이전 설정과 지침 비교</summary>
          <p className="mt-2 font-medium">추가 작업 지침</p>
          <p className="whitespace-pre-wrap">이전: {previous.profile.rolePrompt || "없음"}</p>
          <p className="whitespace-pre-wrap">현재: {current.profile.rolePrompt || "없음"}</p>
          <p className="mt-2 font-medium">기억 검색 도구의 추가 안내</p>
          <p className="whitespace-pre-wrap">
            이전: {previous.profile.memoryToolDescription || "없음"}
          </p>
          <p className="whitespace-pre-wrap">
            현재: {current.profile.memoryToolDescription || "없음"}
          </p>
        </details>
      )}
      <FieldDescription>
        적용 대상은 설정을 채택한 뒤 시작하는 Goal이에요. 진행 중인 Goal은 시작할 때의 설정을
        유지하고, 일반 채팅은 기본 설정을 사용해요.
      </FieldDescription>
    </section>
  );
}

type Measurement = NonNullable<ExperimentRecord["validationBase"]>;

/** Older records did not record their memory task source, so they show none rather than a guess. */
function MemoryTasks({ tasks }: { tasks: ExperimentRecord["memoryTasks"] }) {
  switch (tasks?.kind) {
    case undefined:
      return null;
    case "synthetic":
      return <FieldDescription>기억 과제: 별도로 만든 과제</FieldDescription>;
    case "usage":
      return (
        <FieldDescription>
          기억 과제: 실제 사용 기록의 정정 내용 (버전 {tasks.version})
        </FieldDescription>
      );
  }
}
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function Comparison({
  label,
  base,
  next,
}: {
  label: string;
  base: Measurement;
  next: Measurement;
}) {
  return (
    <FieldDescription>
      {label}: 현재 설정 {percent(base.score)} → 후보 {percent(next.score)} (코딩{" "}
      {percent(base.coding)} → {percent(next.coding)}, 기억 {percent(base.memory)} →{" "}
      {percent(next.memory)})
    </FieldDescription>
  );
}

export function ExperimentSummary({
  experiment,
  reason,
  nextStep,
  scope = "latest",
}: {
  experiment: ExperimentRecord;
  reason: string;
  nextStep?: string | undefined;
  /** The latest experiment is summarized above the controls; history entries repeat it per run. */
  scope?: "latest" | "history";
}) {
  const { status, tokens, progress, baselines } = experiment;
  const adopted = Boolean(experiment.adoptedVersionId) || experiment.reason === "profile_adopted";
  const finishedTitle = scope === "latest" ? "최근 평가 결과" : "평가 결과";
  return (
    <section className="flex flex-col gap-2" aria-label="평가 진행과 결과">
      <h4 className="text-sm font-medium">
        {status === "running" ? "진행 중인 평가" : finishedTitle}
      </h4>
      <p className="text-sm">
        {statusLabels[status]} · {tokens.toLocaleString()} 토큰 사용
      </p>
      <p className="text-sm">
        {adopted
          ? "이 평가에서 검증된 설정을 채택했어요. 코드 변경 후보는 별도로 검토해요."
          : "이 평가에서 적용된 변경은 없어요."}
      </p>
      {status !== "running" && <FieldDescription>{reason}</FieldDescription>}
      {status !== "running" && nextStep && <FieldDescription>다음: {nextStep}</FieldDescription>}
      <MemoryTasks tasks={experiment.memoryTasks} />
      {isTruthy(progress) ? (
        <FieldDescription>
          {status === "running" ? "현재 단계" : "마지막 기록된 단계"}: {phaseLabels[progress.phase]}{" "}
          · {progress.completed}/{progress.total}{" "}
          {["baseline", "candidate_evaluation", "validation", "sealed", "code_validation"].includes(
            progress.phase,
          )
            ? "과제 완료"
            : "완료"}
        </FieldDescription>
      ) : (
        <FieldDescription>
          {isTruthy(baselines?.length)
            ? `현재 설정의 반복 평가 ${baselines.length}/3회를 완료했어요.`
            : "이 기록에는 과제별 진행 정보가 없어 정확한 완료 개수를 알 수 없어요."}
        </FieldDescription>
      )}
      {experiment.validationBase && experiment.validationNew && (
        <>
          <Comparison
            label="검증 과제 성공률"
            base={experiment.validationBase}
            next={experiment.validationNew}
          />
          {experiment.sealedBase && experiment.sealedNew && (
            <Comparison
              label="최종 확인 과제 성공률"
              base={experiment.sealedBase}
              next={experiment.sealedNew}
            />
          )}
          <FieldDescription>
            검증 과제와 처음 보는 최종 확인 과제를 모두 통과해야 채택해요. 코딩과 기억 성능, 토큰
            비용을 함께 확인해요.
          </FieldDescription>
        </>
      )}
      {status === "running" && (
        <FieldDescription>
          먼저 현재 설정을 반복 평가한 뒤 후보를 만들고 비교해요. 후보 평가와 별도 검증을 통과해야
          설정을 채택해요.
        </FieldDescription>
      )}
      <FieldDescription>
        토큰 사용량은 평가에 든 비용이에요. 많이 사용했다는 것만으로 성능이 좋아졌다는 뜻은
        아니에요.
      </FieldDescription>
    </section>
  );
}
