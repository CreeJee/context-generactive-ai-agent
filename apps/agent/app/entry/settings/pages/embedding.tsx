import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect, Schema } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { isTruthy } from "../../../truthy.ts";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { AnimatedNumber } from "~/components/ui/animated-number";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "~/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Progress, ProgressLabel, ProgressValue } from "~/components/ui/progress";
import { Spinner } from "~/components/ui/spinner";
import { dayAndTime } from "~/lib/dates";
import {
  EmbedderRuntime,
  EmbeddingCommand,
  type EmbeddingChoice,
  type EmbeddingOverview,
  GpuState,
  refusalOf,
} from "../../api";
import { useEmbeddingQuery } from "../../queries/global";
import { useEmbeddingMutation } from "../../queries/mutations/global";
import { errorMessage, PageHeader, PageError, pageTitles } from "../shared";

const embeddingChoices = ["auto", "cpu", "gpu"] as const satisfies ReadonlyArray<EmbeddingChoice>;
const choiceLabels = {
  auto: msg({
    message: "자동",
    comment: "Embedding device option: let the app pick (same as GPU)",
  }),
  cpu: msg({ message: "CPU", comment: "Embedding device option: run the model on the CPU" }),
  gpu: msg({ message: "GPU (빠름)", comment: "Embedding device option: run the model on the GPU" }),
} satisfies Record<EmbeddingChoice, MessageDescriptor>;

const modeNames = { cpu: "CPU", gpu: "GPU" } as const;

/** What the model runs on in this process, as a badge. */
function RunningBadge({ running }: { running: EmbedderRuntime }) {
  return EmbedderRuntime.$match(running, {
    other: () => null,
    local: ({ mode, device }) =>
      device === null ? (
        <Badge variant="secondary">
          <Trans comment="Badge: the embedding model is set to {mode} (CPU or GPU) but not loaded yet">
            {ph({ mode: modeNames[mode] })} 모드, 아직 불러오지 않음
          </Trans>
        </Badge>
      ) : mode === "cpu" ? (
        <Badge variant="secondary">
          <Trans>CPU에서 실행 중</Trans>
        </Badge>
      ) : device === "webgpu" ? (
        <Badge variant="secondary">
          <Trans>GPU(WebGPU)에서 실행 중</Trans>
        </Badge>
      ) : (
        <Badge variant="outline">
          <Trans>GPU 모드, CPU에서 실행 중</Trans>
        </Badge>
      ),
  });
}

type ModelDownload = EmbeddingOverview["downloads"][number];

const downloadNames = {
  embedding: msg({ message: "임베딩 모델", comment: "Local model being downloaded" }),
  rerank: msg({ message: "검색 결과 정렬 모델", comment: "Local model being downloaded" }),
} satisfies Record<ModelDownload["purpose"], MessageDescriptor>;

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)}MB`;

/** A local model's download as it goes. */
function DownloadProgress({ download }: { download: ModelDownload }) {
  const { t } = useLingui();
  const model = t(downloadNames[download.purpose]);
  return (
    <Field>
      <Progress value={Math.floor((download.loaded / download.total) * 100)}>
        <ProgressLabel>
          <Trans>{model} 내려받는 중</Trans>
        </ProgressLabel>
        <ProgressValue />
      </Progress>
      <FieldDescription>
        {megabytes(download.loaded)} / {megabytes(download.total)}
      </FieldDescription>
    </Field>
  );
}

/** What the running model means for the user, in words; nothing when the badge says it all. */
const runningNote = EmbedderRuntime.$match({
  other: () => null,
  local: ({ mode, device }) =>
    device === null
      ? t`모델은 처음 임베딩할 때 불러옵니다.`
      : mode === "gpu" && device !== "webgpu"
        ? t`WebGPU를 쓸 수 없어 지금은 CPU에서 GPU용 모델을 돌리고 있습니다. 벡터는 같지만 더 느립니다.`
        : null,
});

/** Why WebGPU could not be used, by the code the check stores; any other value reads generically. */
const GpuUnavailableReason = Schema.Literals([
  "no WebGPU device",
  "worker_load_failed",
  "worker_run_failed",
  "worker_lost_failed",
  "embedding_failed",
]);
const gpuUnavailableReasons = {
  "no WebGPU device": msg`WebGPU 장치를 찾지 못했습니다.`,
  worker_load_failed: msg`임베딩 worker가 모델을 불러오지 못했습니다.`,
  worker_run_failed: msg`임베딩 worker가 시험 임베딩을 하지 못했습니다.`,
  worker_lost_failed: msg`임베딩 worker가 응답 없이 끝났습니다.`,
  embedding_failed: msg`시험 임베딩을 하지 못했습니다.`,
} satisfies Record<typeof GpuUnavailableReason.Type, MessageDescriptor>;
const gpuUnavailableText = (reason: string) =>
  Schema.is(GpuUnavailableReason)(reason)
    ? i18n._(gpuUnavailableReasons[reason])
    : t`확인 중 문제가 생겼습니다.`;

const gpuText = GpuState.$match({
  unchecked: () => t`아직 확인하지 않았습니다.`,
  checking: () => t`확인하는 중입니다. 처음 확인할 때는 GPU용 모델(약 570MB)을 내려받습니다.`,
  available: ({ checkedAt }) => {
    const time = dayAndTime(checkedAt);
    return t`쓸 수 있습니다(${time} 확인).`;
  },
  unavailable: ({ checkedAt, reason }) => {
    const time = dayAndTime(checkedAt);
    return t`쓸 수 없습니다(${time} 확인): ${ph({ reason: gpuUnavailableText(reason) })}`;
  },
});

/** How the embedding model runs: on the CPU, or on the GPU (WebGPU, falling back to the CPU). */
export function EmbeddingSettings() {
  const { t } = useLingui();
  const mutation = useEmbeddingMutation();
  const { data: overview } = useEmbeddingQuery();
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const checking = GpuState.$is("checking")(overview.gpu);
  const indexing = overview.unindexed > 0;

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const apply = (command: EmbeddingCommand) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync(command)).pipe(
          Effect.catchTag("UnknownError", (failure) =>
            Effect.sync(() => setError(errorMessage(refusalOf(failure.cause)))),
          ),
        );
      }),
    );

  const header = (
    <PageHeader
      title={t(pageTitles.embedding)}
      badge={<RunningBadge running={overview.running} />}
      description={
        <Trans>
          기억을 뜻으로 찾을 때 쓰는 벡터를 어디서 만들지 정합니다. 사용자와 모델의 발언만
          임베딩합니다. 도구 기록은 글자 검색으로 찾습니다.
        </Trans>
      }
    />
  );
  const note = runningNote(overview.running);
  const restartNeeded =
    EmbedderRuntime.$is("local")(overview.running) && overview.running.mode !== overview.next;
  const choices = embeddingChoices.map((value) => ({ value, label: t(choiceLabels[value]) }));
  const { maintenance } = overview;

  return (
    <FieldGroup>
      {header}

      <Field>
        <FieldLabel htmlFor="embedding-device">
          <Trans comment="Label of the select that picks CPU or GPU for the embedding model">
            실행 방식
          </Trans>
        </FieldLabel>
        <Select
          value={overview.choice}
          items={choices}
          disabled={busy}
          onValueChange={(value) => {
            const choice = embeddingChoices.find((option) => option === value);
            if (isTruthy(choice)) void apply(EmbeddingCommand.choose({ choice }));
          }}
        >
          <SelectTrigger id="embedding-device" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          <Trans>
            CPU는 벡터를 만드는 동안 코어를 여럿 씁니다. GPU는 CPU를 훨씬 덜 쓰고 다섯 배쯤 빠르며
            메모리도 조금 덜 씁니다. 자동은 GPU와 같습니다. WebGPU를 쓸 수 없으면 같은 모델을
            CPU에서 돌립니다.
          </Trans>
        </FieldDescription>
      </Field>

      {note && <FieldDescription>{note}</FieldDescription>}
      {overview.downloads.map((download) => (
        <DownloadProgress key={download.model} download={download} />
      ))}
      {restartNeeded && (
        <Alert>
          <AlertDescription>
            <Trans>
              앱을 다시 시작한 뒤에는 {ph({ mode: modeNames[overview.next] })} 모드로 돌아갑니다. 그
              모드로 만든 벡터가 없으면 처음부터 다시 만듭니다. 그동안에도 글자 검색과 형태소 검색은
              됩니다.
            </Trans>
          </AlertDescription>
        </Alert>
      )}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>WebGPU</FieldTitle>
          <FieldDescription>{gpuText(overview.gpu)}</FieldDescription>
        </FieldContent>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || checking}
          onClick={() => void apply(EmbeddingCommand.check())}
        >
          {busy || checking ? <Spinner /> : <RefreshCwIcon />}{" "}
          <Trans comment="Button that checks again whether WebGPU can be used">다시 확인</Trans>
        </Button>
      </Field>

      {indexing && (
        <FieldDescription>
          <Trans>
            아직 <AnimatedNumber value={overview.unindexed} />
            개를 임베딩하지 않았습니다. 최근 대화부터 채웁니다.
          </Trans>
        </FieldDescription>
      )}

      <Field>
        <FieldTitle>
          <Trans>기억 그래프 정리</Trans>
        </FieldTitle>
        <FieldDescription>
          <Trans>
            이전 버전이 잘못 남긴 기억 연결을 자동으로 점검합니다. 원문과 정상 벡터는 보존하고 빈
            응답의 의미 연결과 근거 연결 오류만 정리합니다. 정정과 취소 해석은 바꾸지 않습니다.
          </Trans>
        </FieldDescription>
        <FieldDescription>
          {maintenance.status === "running" ? (
            <Trans>저장된 기억을 점검하고 있습니다.</Trans>
          ) : maintenance.status === "completed" ? (
            <Trans>
              근거 연결 {ph({ repaired: maintenance.repairedEdges })}개, 의미 연결{" "}
              {ph({ suppressed: maintenance.suppressedEdges })}개, 불필요한 주제{" "}
              {ph({ retired: maintenance.retiredTopics })}개를 정리했습니다.
            </Trans>
          ) : maintenance.status === "failed" ? (
            maintenance.error
          ) : (
            <Trans>저장된 기억을 자동으로 점검할 예정입니다.</Trans>
          )}
        </FieldDescription>
      </Field>

      <PageError error={error} />
    </FieldGroup>
  );
}
