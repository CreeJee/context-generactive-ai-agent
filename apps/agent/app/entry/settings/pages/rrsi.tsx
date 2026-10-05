import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExperimentRecord, HarnessVersion, RrsiSettings as Configuration } from "memory-agent";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import { Switch } from "~/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { appFetch } from "../../shared/backend-restart";
import { PageHeader, PageError } from "../shared";

interface Status {
  settings: Configuration;
  current: HarnessVersion;
  versions: HarnessVersion[];
  experiments: ExperimentRecord[];
  running: boolean;
  configuredRepository: boolean;
}
const queryKey = ["settings", "rrsi"];
const phaseLabels = {
  baseline: "현재 설정의 기본 동작 평가",
  proposal: "개선 후보 생성",
  critique: "후보의 적합성 검토",
  candidate_evaluation: "개선 후보 평가",
  validation: "별도 과제로 개선 효과 확인",
  sealed: "최종 검증",
  code_proposal: "코드 변경 후보 생성",
  code_build: "코드 후보 빌드와 검사",
  code_validation: "코드 후보 평가",
  finished: "평가 종료",
};
const statusLabels = {
  running: "평가 중",
  completed: "평가 종료",
  failed: "평가 실패",
  cancelled: "평가 중단",
};
const reasons = {
  baseline_quality_failed: "기본 하네스가 코딩·기억 과제를 해결하지 못했어요",
  evaluation_image_unavailable: "평가용 Docker 이미지를 먼저 빌드하세요",
  code_review_pending: "코드 후보 검토를 기다리고 있어요",
  code_evaluation_incomplete: "코드 후보 평가를 완료하지 못했어요",
  profile_adopted: "새 하네스를 채택했어요",
  no_admissible_candidate: "채택 기준을 통과한 후보가 없어요",
  evaluation_failed: "평가를 완료하지 못했어요",
  gateway_request_failed: "모델 요청이 실패했어요. 선택한 모델과 서버 연결을 확인하세요",
  gateway_memory_limit: "모델 서버의 메모리 한도가 부족해요. 서버 설정이나 모델을 확인하세요",
  gateway_protocol_mismatch: "평가 연결의 공급자 형식이 맞지 않아요",
  protocol_invalid: "평가 worker의 응답 형식이 올바르지 않아요",
  worker_failed: "평가 worker가 실패했어요",
  evaluation_container_failed: "평가용 Docker 컨테이너가 종료됐어요",
  evaluation_incomplete: "평가 결과가 완전하지 않아 채택하지 않았어요",
  user_activity: "원본 또는 평가 앱의 작업을 감지해 중단했어요",
  time_limit: "설정한 평가 시간이 끝나 중단했어요",
  manual_stop: "사용자가 평가를 중지했어요",
  disabled: "자동 실행을 꺼서 진행 중인 평가를 중단했어요",
  profile_restored: "프로필을 복원해 진행 중인 평가를 중단했어요",
  app_shutdown: "앱 종료로 평가를 중단했어요",
  activity_check_failed: "실행 중인 작업을 확인하지 못해 평가를 중단했어요",
  usage_unknown: "모델의 토큰 사용량이 누락됐어요",
  owner_restarted: "앱 재시작으로 중단됐어요",
  model_unavailable: "선택한 모델의 연결과 로그인을 확인하세요",
  local_model_unavailable: "로컬 모델 연결을 확인하세요",
  sealed_corpus_exhausted: "최종 평가 과제를 새 버전으로 교체해야 해요",
  experiment_running: "이미 실험 중이에요",
  validation_rejected: "검증 과제를 통과하지 못했어요",
  heldout_rejected: "최종 평가를 통과하지 못했어요",
  edit_budget: "변경 범위를 초과했어요",
  task_leakage: "평가 답을 직접 포함하는 후보라 제외했어요",
  critic_rejected: "적합성 검토를 통과하지 못했어요",
  admissible: "채택 기준을 통과한 후보예요",
  round_winner: "이번 비교에서 선택된 후보예요",
  domain_regression: "코딩 또는 기억 성능이 낮아져 제외했어요",
  within_noise_without_savings: "뚜렷한 성능 향상이나 비용 감소가 없어요",
  below_best_floor: "기존 최고 성능보다 낮아 제외했어요",
  cost_growth: "성능 향상에 비해 평가 비용이 많이 늘었어요",
  code_validating: "코드 후보를 검사하고 있어요",
  pending: "평가를 기다리고 있어요",
};
function reasonLabel(reason: string) {
  return Object.entries(reasons).find(([key]) => key === reason)?.[1];
}
function ExperimentSummary({ experiment }: { experiment: ExperimentRecord }) {
  const { status, tokens, progress, baselines, reason } = experiment;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">
        {status === "running" ? "진행 중인 평가" : "최근 평가 결과"}
      </h4>
      <p className="text-sm">
        {statusLabels[status]} · {tokens.toLocaleString()} 토큰 사용
      </p>
      <FieldDescription>
        {status === "running"
          ? progress
            ? `${phaseLabels[progress.phase]} · ${progress.completed}/${progress.total} 완료`
            : baselines?.length
              ? "기본 평가를 마치고 개선 후보를 검토하고 있어요."
              : "현재 설정의 기본 동작을 평가하고 있어요. 아직 개선이 적용되지 않았어요."
          : (reasonLabel(reason) ?? reason)}
      </FieldDescription>
      <FieldDescription>
        토큰 사용량은 평가에 든 비용이에요. 많이 사용했다는 것만으로 성능이 좋아졌다는 뜻은
        아니에요. 검증을 통과한 후보가 있을 때만 설정이 바뀌어요.
      </FieldDescription>
    </div>
  );
}
async function request(body?: {
  action: string;
  settings?: Configuration;
  versionId?: string;
}): Promise<Status> {
  const response = await appFetch(
    "/api/settings/rrsi",
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (!response.ok) {
    if (response.status === 404)
      throw new Error(
        "실행 중인 서버가 하네스 개선 설정을 지원하지 않아요. 앱 서버를 재시작한 뒤 다시 시도하세요.",
      );
    const page: { error: string } = await response.json();
    throw new Error(reasonLabel(page.error) ?? "요청을 처리하지 못했어요");
  }
  return response.json();
}
export function RrsiSettings() {
  const cache = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const {
    data: status,
    error: queryError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: () => request(),
    refetchInterval: 5000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: request,
    onSuccess: () => {
      setError(null);
      void cache.invalidateQueries({ queryKey });
    },
    onError: (failure) => setError(failure.message),
  });
  if (!status)
    return (
      <FieldGroup>
        <PageHeader
          title="동작 개선 실험"
          description="에이전트의 작업 지침과 기억 검색 설정을 별도 과제로 평가해요."
        />
        {queryError ? (
          <>
            <PageError error={queryError.message} />
            <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
              다시 시도
            </Button>
          </>
        ) : (
          <FieldDescription role="status">개선 실험 설정을 불러오는 중이에요.</FieldDescription>
        )}
      </FieldGroup>
    );
  return (
    <FieldGroup>
      <PageHeader
        title="동작 개선 실험"
        badge={<Badge variant="secondary">{status.running ? "실험 중" : "대기"}</Badge>}
        description="프로젝트 공통으로 쓰는 작업 지침과 기억 검색 설정의 개선 후보를 찾는 실험이에요. 별도의 코딩·기억 과제로 현재 설정과 비교하고, 검증을 통과한 설정을 새 Goal에 적용해요."
      />
      <FieldDescription>
        진행 중인 Goal은 시작할 때의 설정을 유지해요. 보관된 프로젝트는 작업 감지에서 제외해요. 코드
        변경 후보는 검토 후 수동으로 반영해요.
      </FieldDescription>
      <FieldDescription>
        {status.current.id === "baseline"
          ? "현재 적용 상태: 아직 적용된 개선이 없어요. 기본 설정을 사용하고 있어요."
          : `현재 적용 상태: 검증된 설정 ${status.current.id.slice(0, 8)}을 새 Goal에 사용해요.`}
      </FieldDescription>
      {status.experiments[0] && <ExperimentSummary experiment={status.experiments[0]} />}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="rrsi-enabled">유휴 시간에 자동 실행</FieldLabel>
          <FieldDescription>
            10분 유휴 후 하루 최대 1회 · {status.settings.maxMinutes}분 · 토큰 상한 없음. 원본
            앱에서 작업하면 중단해요.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="rrsi-enabled"
          checked={status.settings.enabled}
          disabled={mutation.isPending}
          onCheckedChange={(enabled) =>
            mutation.mutate({ action: "settings", settings: { ...status.settings, enabled } })
          }
        />
      </Field>
      <FieldDescription>
        토큰 사용량은 효율 비교를 위해 기록해요. 선택한 공급자의 요금과 사용 정책이 적용돼요.
      </FieldDescription>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={mutation.isPending || status.running}
          onClick={() => mutation.mutate({ action: "start" })}
        >
          평가 시작
        </Button>
        <Button
          variant="outline"
          disabled={mutation.isPending || !status.running}
          onClick={() => mutation.mutate({ action: "stop" })}
        >
          중지
        </Button>
      </div>
      <FieldDescription>
        현재 버전: {status.current.id === "baseline" ? "기본 설정" : status.current.id.slice(0, 8)}.
        기존 Goal은 고정된 버전을 유지해요.
      </FieldDescription>
      {status.versions
        .filter((version) => version.id !== status.current.id)
        .map((version) => (
          <div key={version.id} className="flex items-center justify-between gap-2">
            <span>{version.id === "baseline" ? "기본 설정" : version.id.slice(0, 8)}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ action: "restore", versionId: version.id })}
            >
              이 버전 복원
            </Button>
          </div>
        ))}
      {status.experiments.map((experiment) => (
        <Collapsible key={experiment.id}>
          <CollapsibleTrigger render={<Button variant="ghost" />}>
            {new Date(experiment.startedAt).toLocaleString()} · {statusLabels[experiment.status]} ·{" "}
            {experiment.tokens.toLocaleString()} 토큰
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p>{reasonLabel(experiment.reason) ?? experiment.reason}</p>
            {experiment.candidates.map((candidate) => (
              <div key={candidate.id} className="flex flex-col gap-2 py-2">
                <p>
                  {candidate.kind === "code" ? "코드 후보" : `라운드 ${candidate.round + 1}`}:{" "}
                  {reasonLabel(candidate.decision) ?? candidate.decision}{" "}
                  {candidate.measurement
                    ? `· 성공률 ${(candidate.measurement.score * 100).toFixed(1)}%`
                    : ""}
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{candidate.diff}</pre>
                {candidate.branch && <code>{candidate.branch}</code>}
                {candidate.commit && <code>commit: {candidate.commit}</code>}
                {candidate.imageId && <code>artifact: {candidate.imageId}</code>}
                {candidate.decision === "code_review_pending" && (
                  <FieldDescription>
                    평가를 통과한 후보예요. 위 diff와 커밋을 검토한 뒤 별도 브랜치에서 반영하세요.
                  </FieldDescription>
                )}
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      ))}
      <PageError error={error ?? queryError?.message ?? null} />
    </FieldGroup>
  );
}
