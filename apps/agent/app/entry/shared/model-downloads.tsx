import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { cn } from "cn";
import { Progress, ProgressLabel } from "~/components/ui/progress";
import { type DownloadPurpose, ModelDownload } from "../api";
import { useModelDownloadsQuery } from "../queries/global";
import { useRetryDownloadMutation } from "../queries/mutations/global";
import { LoadFailed } from "./load-failed";

type Downloading = Extract<ModelDownload, { _tag: "downloading" }>;

const modelNames = {
  embedding: msg({ message: "임베딩 모델", comment: "Local model being downloaded" }),
  rerank: msg({ message: "검색 결과 정렬 모델", comment: "Local model being downloaded" }),
  "gpu-check": msg({
    message: "GPU 확인용 임베딩 모델",
    comment: "Local model being downloaded: the GPU file the settings page's WebGPU check loads",
  }),
} satisfies Record<DownloadPurpose, MessageDescriptor>;

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)}MB`;

/** The models being downloaded now and the failed downloads; none until known. */
export const useModelDownloads = (): readonly ModelDownload[] =>
  useModelDownloadsQuery().data ?? [];

/** How far a download is, in words: bytes and percent, and the time left once it is guessed. */
function DownloadAmount({ download }: { download: Downloading }) {
  const { t } = useLingui();
  const { loaded, total, secondsLeft } = download;
  if (total === 0) return <Trans>내려받을 크기를 확인하는 중</Trans>;
  if (loaded >= total) return <Trans>다 내려받아 불러오는 중</Trans>;
  const done = megabytes(loaded);
  const size = megabytes(total);
  const percent = Math.floor((loaded / total) * 100);
  const amount = t`${done} / ${size} (${percent}%)`;
  if (secondsLeft === null) return amount;
  const allMinutes = Math.ceil(secondsLeft / 60);
  const hours = Math.floor(allMinutes / 60);
  const minutes = allMinutes % 60;
  const left =
    secondsLeft < 60
      ? t`남은 시간 1분 이내`
      : hours === 0
        ? t`남은 시간 약 ${minutes}분`
        : t`남은 시간 약 ${hours}시간 ${minutes}분`;
  return `${amount} · ${left}`;
}

/** One download as it goes, or a failed one with a button to download it again. */
export function ModelDownloadRow({ download }: { download: ModelDownload }) {
  const { t } = useLingui();
  const retry = useRetryDownloadMutation();
  const model = t(modelNames[download.purpose]);
  return ModelDownload.$match(download, {
    downloading: (downloading) => (
      <Progress
        value={
          downloading.total === 0
            ? null
            : Math.floor((downloading.loaded / downloading.total) * 100)
        }
      >
        <ProgressLabel>
          <Trans>{model} 내려받는 중</Trans>
        </ProgressLabel>
        <span className="w-full text-xs text-muted-foreground tabular-nums">
          <DownloadAmount download={downloading} />
        </span>
      </Progress>
    ),
    failed: ({ purpose }) => (
      <LoadFailed onRetry={() => retry.mutate(purpose)}>
        <Trans>{model}을 내려받지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주십시오.</Trans>
      </LoadFailed>
    ),
  });
}

/** Every model download the app runs, for the sidebar and the settings page; nothing when none. */
export function ModelDownloadList({ className }: { className?: string }) {
  const { t } = useLingui();
  const downloads = useModelDownloads();
  if (downloads.length === 0) return null;
  return (
    <section aria-label={t`모델 내려받기`} className={cn("flex flex-col gap-3", className)}>
      {downloads.map((download) => (
        <ModelDownloadRow key={download.purpose} download={download} />
      ))}
    </section>
  );
}

/**
 * Why a turn may take long to start: a turn searches memory with the embedding model, and waits
 * while that model is downloaded or loaded. Nothing when it is not.
 */
export function TurnWaitsForModel() {
  const { t } = useLingui();
  const embedding = useModelDownloads().find(({ purpose }) => purpose === "embedding");
  if (embedding === undefined) return null;
  return ModelDownload.$match(embedding, {
    downloading: (downloading) =>
      downloading.total > 0 && downloading.loaded >= downloading.total ? (
        <span>
          <Trans>기억을 찾는 임베딩 모델을 불러오는 중이라 답이 늦어질 수 있습니다.</Trans>
        </span>
      ) : (
        <span className="flex flex-col gap-1">
          <span>
            <Trans>
              기억을 찾는 임베딩 모델을 내려받는 중이라 답이 늦어질 수 있습니다:{" "}
              <DownloadAmount download={downloading} />
            </Trans>
          </span>
          {downloading.total > 0 && (
            <Progress
              aria-label={t`임베딩 모델 내려받기`}
              value={Math.floor((downloading.loaded / downloading.total) * 100)}
            />
          )}
        </span>
      ),
    failed: () => <ModelDownloadRow download={embedding} />,
  });
}
