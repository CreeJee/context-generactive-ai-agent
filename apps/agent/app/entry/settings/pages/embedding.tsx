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
import { errorMessage, PageHeader, PageError } from "../shared";
import { settingsCopy } from "../copy";

const copy = settingsCopy.embedding;

const embeddingChoices = [
  { value: "auto", label: copy.choices.auto },
  { value: "cpu", label: copy.choices.cpu },
  { value: "gpu", label: copy.choices.gpu },
] as const satisfies ReadonlyArray<{ value: EmbeddingChoice; label: string }>;

const modeNames = { cpu: "CPU", gpu: "GPU" } as const;

/** What the model runs on in this process, as a badge. */
function RunningBadge({ running }: { running: EmbedderRuntime }) {
  return EmbedderRuntime.$match(running, {
    other: () => null,
    local: ({ mode, device }) =>
      device === null ? (
        <Badge variant="secondary">{copy.running.notLoaded(modeNames[mode])}</Badge>
      ) : mode === "cpu" ? (
        <Badge variant="secondary">{copy.running.cpu}</Badge>
      ) : device === "webgpu" ? (
        <Badge variant="secondary">{copy.running.webgpu}</Badge>
      ) : (
        <Badge variant="outline">{copy.running.gpuOnCpu}</Badge>
      ),
  });
}

type ModelDownload = EmbeddingOverview["downloads"][number];

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)}MB`;

/** A local model's download as it goes. */
function DownloadProgress({ download }: { download: ModelDownload }) {
  return (
    <Field>
      <Progress value={Math.floor((download.loaded / download.total) * 100)}>
        <ProgressLabel>{copy.downloading(copy.downloads[download.purpose])}</ProgressLabel>
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
      ? copy.runningNote.notLoaded
      : mode === "gpu" && device !== "webgpu"
        ? copy.runningNote.gpuOnCpu
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
const gpuUnavailableReasons = copy.gpuUnavailable satisfies Record<
  typeof GpuUnavailableReason.Type,
  string
>;
const gpuUnavailableText = (reason: string) =>
  Schema.is(GpuUnavailableReason)(reason)
    ? gpuUnavailableReasons[reason]
    : copy.gpuUnavailableOther;

const gpuText = GpuState.$match({
  unchecked: () => copy.gpu.unchecked,
  checking: () => copy.gpu.checking,
  available: ({ checkedAt }) => copy.gpu.available(dayAndTime(checkedAt)),
  unavailable: ({ checkedAt, reason }) =>
    copy.gpu.unavailable(dayAndTime(checkedAt), gpuUnavailableText(reason)),
});

/** How the embedding model runs: on the CPU, or on the GPU (WebGPU, falling back to the CPU). */
export function EmbeddingSettings() {
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
      title={settingsCopy.titles.embedding}
      badge={<RunningBadge running={overview.running} />}
      description={copy.description}
    />
  );
  const note = runningNote(overview.running);
  const restartNeeded =
    EmbedderRuntime.$is("local")(overview.running) && overview.running.mode !== overview.next;

  return (
    <FieldGroup>
      {header}

      <Field>
        <FieldLabel htmlFor="embedding-device">{copy.deviceLabel}</FieldLabel>
        <Select
          value={overview.choice}
          items={embeddingChoices}
          disabled={busy}
          onValueChange={(value) => {
            const choice = embeddingChoices.find((option) => option.value === value);
            if (isTruthy(choice)) void apply(EmbeddingCommand.choose({ choice: choice.value }));
          }}
        >
          <SelectTrigger id="embedding-device" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {embeddingChoices.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{copy.deviceHelp}</FieldDescription>
      </Field>

      {note && <FieldDescription>{note}</FieldDescription>}
      {overview.downloads.map((download) => (
        <DownloadProgress key={download.model} download={download} />
      ))}
      {restartNeeded && (
        <Alert>
          <AlertDescription>{copy.restart(modeNames[overview.next])}</AlertDescription>
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
          {busy || checking ? <Spinner /> : <RefreshCwIcon />} {copy.recheck}
        </Button>
      </Field>

      {indexing && (
        <FieldDescription>
          {copy.unindexed.before} <AnimatedNumber value={overview.unindexed} />
          {copy.unindexed.after}
        </FieldDescription>
      )}

      <Field>
        <FieldTitle>{copy.maintenance.title}</FieldTitle>
        <FieldDescription>{copy.maintenance.description}</FieldDescription>
        <FieldDescription>
          {overview.maintenance.status === "running"
            ? copy.maintenance.running
            : overview.maintenance.status === "completed"
              ? copy.maintenance.completed(
                  overview.maintenance.repairedEdges,
                  overview.maintenance.suppressedEdges,
                  overview.maintenance.retiredTopics,
                )
              : overview.maintenance.status === "failed"
                ? overview.maintenance.error
                : copy.maintenance.scheduled}
        </FieldDescription>
      </Field>

      <PageError error={error} />
    </FieldGroup>
  );
}
