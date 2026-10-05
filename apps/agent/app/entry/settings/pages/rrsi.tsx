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
import { AppliedSettings, ExperimentSummary, statusLabels } from "./rrsi-summary";

interface Status {
  settings: Configuration;
  current: HarnessVersion;
  versions: HarnessVersion[];
  experiments: ExperimentRecord[];
  running: boolean;
  configuredRepository: boolean;
}
class ExperimentRequestFailed extends Error {
  readonly _tag = "ExperimentRequestFailed";
  constructor(
    readonly reason: "server_restart_required" | "request_failed",
    message: string,
  ) {
    super(message);
    this.name = "ExperimentRequestFailed";
  }
}
const queryKey = ["settings", "rrsi"];
const reasons = {
  baseline_quality_failed: "현재 설정이 코딩·기억 과제를 해결하지 못해 후보를 만들지 않았어요",
  evaluation_image_unavailable: "평가용 Docker 이미지를 먼저 빌드하세요",
  code_review_pending: "코드 후보 검토를 기다리고 있어요",
  code_evaluation_incomplete: "코드 후보 평가를 완료하지 못했어요",
  profile_adopted: "검증된 작업 지침과 기억 검색 설정을 새 Goal에 적용했어요",
  no_admissible_candidate: "채택 기준을 통과한 후보가 없어요",
  evaluation_failed: "평가를 완료하지 못했어요",
  gateway_request_failed: "모델 요청이 실패했어요. 선택한 모델과 서버 연결을 확인하세요",
  gateway_memory_limit: "모델 서버의 메모리 한도가 부족해요. 서버 설정이나 모델을 확인하세요",
  gateway_protocol_mismatch: "평가 연결의 공급자 형식이 맞지 않아요",
  protocol_invalid: "평가 worker의 응답 형식이 올바르지 않아요",
  trial_execution_failed: "평가 과제를 실행하는 중 오류가 발생해 점수로 처리하지 않았어요",
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
      throw new ExperimentRequestFailed(
        "server_restart_required",
        "실행 중인 서버가 동작 개선 실험을 지원하지 않아요. 앱 서버를 재시작한 뒤 다시 시도하세요.",
      );
    const page: { error: string } = await response.json();
    throw new ExperimentRequestFailed(
      "request_failed",
      reasonLabel(page.error) ?? "요청을 처리하지 못했어요",
    );
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
        description="에이전트가 일을 수행하는 방법을 개선하는 실험이에요. 추가 작업 지침, 기억 검색 개수·길이, 기억 검색 도구의 안내를 바꿔 별도로 만든 코딩·기억 과제에서 비교해요."
      />
      <FieldDescription>
        프로젝트 공통 설정을 평가해요. 활성 프로젝트의 실행 작업과 대기 메시지는 실험을 멈출지
        판단하는 데 사용해요. 보관된 프로젝트는 이 작업 감지에서 제외해요. 코드 개선은 별도 브랜치에
        변경 후보를 만들고, 검토한 뒤 수동으로 반영해요.
      </FieldDescription>
      <AppliedSettings current={status.current} versions={status.versions} />
      {status.experiments[0] && (
        <ExperimentSummary
          experiment={status.experiments[0]}
          reason={reasonLabel(status.experiments[0].reason) ?? "평가가 종료됐어요."}
        />
      )}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="rrsi-enabled">유휴 시간에 자동 실행</FieldLabel>
          <FieldDescription>
            10분 유휴 후 하루 최대 1회 · {status.settings.maxMinutes}분 · 토큰 상한 없음. 활성
            프로젝트에서 실행 작업이나 대기 메시지가 감지되면 중단해요.
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
            <ExperimentSummary
              experiment={experiment}
              reason={reasonLabel(experiment.reason) ?? "평가가 종료됐어요."}
            />
            {experiment.candidates.map((candidate) => (
              <div key={candidate.id} className="flex flex-col gap-2 py-2">
                <p>
                  {candidate.kind === "code" ? "코드 후보" : `라운드 ${candidate.round + 1}`}:{" "}
                  {reasonLabel(candidate.decision) ?? candidate.decision}{" "}
                  {candidate.measurement
                    ? `· 성공률 ${(candidate.measurement.score * 100).toFixed(1)}%`
                    : ""}
                </p>
                <details className="text-sm">
                  <summary className="cursor-pointer">변경 내용 보기</summary>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-xs">
                    {candidate.diff}
                  </pre>
                </details>
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
