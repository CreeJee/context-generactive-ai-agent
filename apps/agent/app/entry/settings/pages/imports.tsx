import { BotIcon, RefreshCwIcon } from "lucide-react";
import { Schema } from "effect";
import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { AnimatedNumber } from "~/components/ui/animated-number";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "~/components/ui/item";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { timeOfDay } from "~/lib/dates";
import { type ImportActivity } from "../../api";
import { useImportsQuery } from "../../queries/global";
import { useImportMutation } from "../../queries/mutations/global";
import { errorMessage, PageHeader, PageError, shortPath } from "../shared";

const sourceNames = { "claude-code": "Claude Code", codex: "Codex CLI" } as const;

/** Why registering a recorded working directory as a project did not work. */
const UnplacedReason = Schema.Literal(
  "not_found",
  "not_directory",
  "overlaps_storage",
  "no_session_line",
  "no_project",
);
const unplacedReasons = {
  not_found: "폴더가 없어졌어요",
  not_directory: "폴더가 아니에요",
  overlaps_storage: "이 앱의 저장 폴더 안이에요",
  no_session_line: "어느 대화인지 알 수 없어요",
  no_project: "프로젝트를 찾지 못했어요",
} satisfies Record<typeof UnplacedReason.Type, string>;
const isUnplacedReason = Schema.is(UnplacedReason);

/** A reason this build does not know yet is shown as it came, rather than hidden. */
const unplacedReason = (reason: string) =>
  isUnplacedReason(reason) ? unplacedReasons[reason] : reason;

/** How often the page asks again while a pass reads, and while its nodes wait to be indexed. */
/** The pass this server is running, or how its latest one went. */
function ImportActivityLine({ activity }: { activity: ImportActivity }) {
  switch (activity.status) {
    case "running":
      return (
        <FieldDescription className="flex items-center">
          <Spinner className="mr-1.5" />
          <span>
            기록을 읽는 중이에요. <AnimatedNumber value={activity.checked} />/
            <AnimatedNumber value={activity.total} />
            개를 확인하고 노드 <AnimatedNumber value={activity.written} />
            개를 더했어요.
            {activity.failed > 0 && (
              <>
                {" "}
                <AnimatedNumber value={activity.failed} />
                개는 읽지 못했어요.
              </>
            )}
          </span>
        </FieldDescription>
      );
    case "finished":
      return (
        <FieldDescription>
          {timeOfDay(activity.finishedAt)}에 기록 {activity.checked}개를 확인하고 노드{" "}
          {activity.written}개를 더했어요.
          {activity.failed > 0 && ` ${activity.failed}개는 읽지 못했어요.`}
        </FieldDescription>
      );
    case "crashed":
      return (
        <FieldError>
          {timeOfDay(activity.finishedAt)}에 가져오기가 중간에 멈췄어요: {activity.reason}
        </FieldError>
      );
  }
}

/** Migrating other coding agents' local conversations into this app's memory. */
export function ImportSettings() {
  const mutation = useImportMutation();
  const { data: overview } = useImportsQuery();
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const reading = overview.activity?.status === "running";

  const apply = async (
    command: { action: "run" | "enable" | "disable" } | { action: "interpret"; interpret: boolean },
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
      title="대화 가져오기"
      description="Claude Code와 Codex CLI가 이 컴퓨터에 남긴 대화를 기억으로 옮겨요. 도구 호출과 결과까지 옮겨서 옛 대화도 근거를 따라갈 수 있고, 원본 파일은 읽기만 해요."
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={busy || reading}
          onClick={() => void apply({ action: "run" })}
        >
          {busy || reading ? <Spinner /> : <RefreshCwIcon />}
          {reading ? "읽는 중" : "지금 가져오기"}
        </Button>
      }
    />
  );
  return (
    <FieldGroup>
      {header}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="imports-enabled">계속 가져오기</FieldLabel>
          <FieldDescription>
            5분마다 새로 쌓인 대화를 이어서 읽어요. 켤 때 지금 있는 기록을 한 번 읽어요.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="imports-enabled"
          checked={overview.enabled}
          disabled={busy}
          onCheckedChange={(checked) => void apply({ action: checked ? "enable" : "disable" })}
        />
      </Field>

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="imports-interpret">가져온 발언도 해석</FieldLabel>
          <FieldDescription>
            주제를 붙이고 정정, 취소 관계를 정리해요. 모델을 쓰기 때문에 답변이 끝난 뒤 조금씩
            처리돼요.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="imports-interpret"
          checked={overview.interpret}
          disabled={busy}
          onCheckedChange={(checked) => void apply({ action: "interpret", interpret: checked })}
        />
      </Field>

      <ItemGroup>
        {overview.sources.map((source) => (
          <Item key={source.name} variant="outline" size="sm">
            <ItemMedia variant="icon">
              <BotIcon />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle>{sourceNames[source.name]}</ItemTitle>
              <ItemDescription>
                기록 <AnimatedNumber value={source.transcripts} />개 중{" "}
                <AnimatedNumber value={source.migrated} />
                개를 읽어 노드 <AnimatedNumber value={source.nodes} />
                개를 넣었어요.
                {source.failed > 0 && ` ${source.failed}개는 읽지 못했어요.`}
              </ItemDescription>
              <ItemDescription className="break-all" title={source.root}>
                <code>{shortPath(source.root)}</code>
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>

      {overview.activity && <ImportActivityLine activity={overview.activity} />}

      {overview.unindexed > 0 && (
        <FieldDescription>
          아직 <AnimatedNumber value={overview.unindexed} />
          개를 인덱싱하고 있어요. 최근 대화부터 채우고, 그동안에도 글자 검색과 형태소 검색으로는
          찾을 수 있어요.
        </FieldDescription>
      )}

      <FieldDescription>
        대화가 있던 폴더는 프로젝트로 등록돼요. 에이전트가 그 폴더의 파일을 읽고 고칠 수 있게 되니,
        필요 없는 프로젝트는 사이드바에서 목록에서 빼세요.
      </FieldDescription>

      {overview.unplaced.length > 0 && (
        <Alert>
          <AlertDescription>
            <div className="mb-1">아래 폴더는 프로젝트로 만들 수 없어 가져오지 않았어요.</div>
            <ul className="font-mono text-xs">
              {overview.unplaced.map((folder) => (
                <li key={`${folder.cwd}:${folder.reason}`}>
                  {folder.cwd}: 대화 {folder.transcripts}개, {unplacedReason(folder.reason)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {overview.failures.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <div className="mb-1">아래 기록은 읽지 못했어요. 다음에 읽을 때 다시 시도해요.</div>
            <ul className="font-mono text-xs">
              {overview.failures.map((failure) => (
                <li key={`${failure.source}:${failure.path}`}>
                  {failure.path}: {failure.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <PageError error={error} />
    </FieldGroup>
  );
}
