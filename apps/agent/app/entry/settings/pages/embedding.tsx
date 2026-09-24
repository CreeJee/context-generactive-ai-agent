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
import { Spinner } from "~/components/ui/spinner";
import { dayAndTime } from "~/lib/dates";
import { type EmbeddingChoice, type EmbeddingOverview, type GpuState } from "../../api";
import { useEmbeddingQuery } from "../../queries/global";
import { useEmbeddingMutation } from "../../queries/mutations/global";
import { errorMessage, PageHeader, PageError } from "../shared";

const embeddingChoices = [
  { value: "auto", label: "자동" },
  { value: "cpu", label: "CPU (메모리 적게)" },
  { value: "gpu", label: "GPU (CPU 적게)" },
] as const satisfies ReadonlyArray<{ value: EmbeddingChoice; label: string }>;

const modeNames = { cpu: "CPU", gpu: "GPU" } as const;

/** How often the page asks again while WebGPU is checked or nodes wait to be embedded. */
const gibibytes = (bytes: number) => Math.round(bytes / 1024 ** 3);

/** What the model runs on in this process, as a badge. */
function RunningBadge({ running }: { running: EmbeddingOverview["running"] }) {
  switch (running.kind) {
    case "other":
      return null;
    case "local":
      if (running.device === null)
        return (
          <Badge variant="secondary">{modeNames[running.mode]} 모드, 아직 불러오지 않음</Badge>
        );
      switch (running.mode) {
        case "cpu":
          return <Badge variant="secondary">CPU에서 실행 중</Badge>;
        case "gpu":
          return running.device === "webgpu" ? (
            <Badge variant="secondary">GPU(WebGPU)에서 실행 중</Badge>
          ) : (
            <Badge variant="outline">GPU 모드, CPU에서 실행 중</Badge>
          );
      }
  }
}

/** What the running model means for the user, in words; nothing when the badge says it all. */
function runningNote(running: EmbeddingOverview["running"]) {
  switch (running.kind) {
    case "other":
      return null;
    case "local":
      if (running.device === null) return "모델은 처음 임베딩할 때 불러와요.";
      switch (running.mode) {
        case "cpu":
          return null;
        case "gpu":
          return running.device === "webgpu"
            ? null
            : "WebGPU를 쓸 수 없어 CPU에서 원본 모델을 돌리고 있어요. 벡터는 같지만 더 느려요.";
      }
  }
}

function gpuText(gpu: GpuState) {
  switch (gpu.status) {
    case "unchecked":
      return "아직 확인하지 않았어요.";
    case "checking":
      return "확인하는 중이에요. 처음이면 원본 모델(약 390MB)을 내려받아요.";
    case "available":
      return `쓸 수 있어요(${dayAndTime(gpu.checkedAt)} 확인).`;
    case "unavailable":
      return `쓸 수 없어요(${dayAndTime(gpu.checkedAt)} 확인): ${gpu.reason}`;
  }
}

/** How the embedding model runs: on the CPU with little memory, or on the GPU with little CPU. */
export function EmbeddingSettings() {
  const mutation = useEmbeddingMutation();
  const { data: overview } = useEmbeddingQuery();
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const checking = overview.gpu.status === "checking";
  const indexing = overview.unindexed > 0;

  const apply = async (
    command: { action: "choose"; choice: EmbeddingChoice } | { action: "check" },
  ) => {
    setError(null);
    try {
      await mutation.mutateAsync(command);
    } catch (failure) {
      setError(errorMessage(failure instanceof Error ? failure : new Error(String(failure))));
    }
  };

  const header = (
    <PageHeader
      title="임베딩"
      badge={<RunningBadge running={overview.running} />}
      description="기억을 뜻으로 찾을 때 쓰는 벡터를 어디서 만들지 정해요. 사용자와 모델의 발언만 임베딩하고, 도구 기록은 글자 검색으로 찾아요."
    />
  );
  const note = runningNote(overview.running);
  const restartNeeded =
    overview.running.kind === "local" && overview.running.mode !== overview.next;

  return (
    <FieldGroup>
      {header}

      <Field>
        <FieldLabel htmlFor="embedding-device">실행 방식</FieldLabel>
        <Select
          value={overview.choice}
          items={embeddingChoices}
          disabled={busy}
          onValueChange={(value) => {
            const choice = embeddingChoices.find((option) => option.value === value);
            if (choice) void apply({ action: "choose", choice: choice.value });
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
        <FieldDescription>
          CPU는 메모리를 적게 쓰는 대신 벡터를 만드는 동안 코어를 여럿 써요. GPU는 CPU를 훨씬 덜
          쓰지만 메모리를 1~1.6GB 더 써요. 자동은 메모리가 {gibibytes(overview.gpuMemoryThreshold)}
          GB 이상이고 WebGPU가 되면 GPU를 써요. 이 기기의 메모리는 {gibibytes(overview.memoryBytes)}
          GB예요.
        </FieldDescription>
      </Field>

      {note && <FieldDescription>{note}</FieldDescription>}
      {restartNeeded && (
        <Alert>
          <AlertDescription>
            앱을 다시 시작하면 {modeNames[overview.next]} 모드로 돌아가요. 그 모드로 만든 벡터가
            없으면 처음부터 다시 만들고, 그동안에도 글자 검색과 형태소 검색은 돼요.
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
          onClick={() => void apply({ action: "check" })}
        >
          {busy || checking ? <Spinner /> : <RefreshCwIcon />} 다시 확인
        </Button>
      </Field>

      {indexing && (
        <FieldDescription>
          아직 <AnimatedNumber value={overview.unindexed} />
          개를 임베딩하지 않았어요. 최근 대화부터 채워요.
        </FieldDescription>
      )}

      <PageError error={error} />
    </FieldGroup>
  );
}
