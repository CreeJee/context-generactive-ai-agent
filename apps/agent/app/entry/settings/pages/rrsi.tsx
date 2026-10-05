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
const reasons = {
  baseline_quality_failed: "기본 하네스가 코딩·기억 과제를 해결하지 못했어요",
  evaluation_image_unavailable: "평가용 Docker 이미지를 먼저 빌드하세요",
  code_review_pending: "코드 후보 검토를 기다리고 있어요",
  code_evaluation_incomplete: "코드 후보 평가를 완료하지 못했어요",
  profile_adopted: "새 하네스를 채택했어요",
  no_admissible_candidate: "채택 기준을 통과한 후보가 없어요",
  evaluation_failed: "평가를 완료하지 못했어요",
  usage_unknown: "모델의 토큰 사용량이 누락됐어요",
  owner_restarted: "앱 재시작으로 중단됐어요",
  model_unavailable: "선택한 모델의 연결과 로그인을 확인하세요",
  local_model_unavailable: "로컬 모델 연결을 확인하세요",
  sealed_corpus_exhausted: "최종 평가 과제를 새 버전으로 교체해야 해요",
  experiment_running: "이미 실험 중이에요",
  validation_rejected: "검증 과제를 통과하지 못했어요",
  heldout_rejected: "최종 평가를 통과하지 못했어요",
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
    const page: { error: string } = await response.json();
    throw new Error(reasonLabel(page.error) ?? "요청을 처리하지 못했어요");
  }
  return response.json();
}
export function RrsiSettings() {
  const cache = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data: status } = useQuery({ queryKey, queryFn: () => request(), refetchInterval: 5000 });
  const mutation = useMutation({
    mutationFn: request,
    onSuccess: () => {
      setError(null);
      void cache.invalidateQueries({ queryKey });
    },
    onError: (failure) => setError(failure.message),
  });
  if (!status) return <PageError error={error} />;
  return (
    <FieldGroup>
      <PageHeader
        title="하네스 개선"
        badge={<Badge variant="secondary">{status.running ? "실험 중" : "대기"}</Badge>}
        description="선택한 공급자·모델로 코딩과 기억 과제를 평가해요. 검증된 프롬프트·설정은 새 Goal에 적용하고, 코드 변경은 후보 브랜치에서 검토하고 수동으로 반영해요."
      />
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
          지금 실험
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
        현재 버전:{" "}
        {status.current.id === "baseline" ? "기본 하네스" : status.current.id.slice(0, 8)}. 기존
        Goal은 고정된 버전을 유지해요.
      </FieldDescription>
      {status.versions
        .filter((version) => version.id !== status.current.id)
        .map((version) => (
          <div key={version.id} className="flex items-center justify-between gap-2">
            <span>{version.id === "baseline" ? "기본 하네스" : version.id.slice(0, 8)}</span>
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
            {new Date(experiment.startedAt).toLocaleString()} · {experiment.status} ·{" "}
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
      <PageError error={error} />
    </FieldGroup>
  );
}
