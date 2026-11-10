import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Array as Arr, type Data, Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
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
import { ImportActivity, ImportCommand, refusalOf } from "../../api";
import { useImportsQuery } from "../../queries/global";
import { useImportMutation } from "../../queries/mutations/global";
import { errorMessage, PageHeader, PageError, pageTitles, shortPath } from "../shared";
import { LoopHealthStatus } from "../../shared/loop-health";

const sourceNames = { "claude-code": "Claude Code", codex: "Codex CLI" } as const;

/** Why registering a recorded working directory as a project did not work. */
const UnplacedReason = Schema.Literals([
  "not_found",
  "not_directory",
  "overlaps_storage",
  "no_session_line",
  "no_project",
]);
const unplacedReasons = {
  not_found: msg`폴더가 없어졌습니다`,
  not_directory: msg`폴더가 아닙니다`,
  overlaps_storage: msg`이 앱의 저장 폴더 안입니다`,
  no_session_line: msg`어느 대화인지 알 수 없습니다`,
  no_project: msg`프로젝트를 찾지 못했습니다`,
} satisfies Record<typeof UnplacedReason.Type, MessageDescriptor>;
const isUnplacedReason = Schema.is(UnplacedReason);

/** A reason this build does not know yet is shown as it came, rather than hidden. */
const unplacedReason = (reason: string) =>
  isUnplacedReason(reason) ? i18n._(unplacedReasons[reason]) : reason;

/** The failure tags a transcript's import records, as `Tag` or `Tag:Reason` joined by commas. */
const ImportFailureTag = Schema.Literals([
  "PlatformError",
  "SchemaError",
  "TranscriptDecompressFailed",
  "ImportStoreFailed",
  "BulkWriteFailed",
  "SqlError",
  "Defect",
  "Interrupted",
]);
const importFailureTexts = {
  PlatformError: msg`파일을 읽지 못했습니다`,
  SchemaError: msg`기록 형식을 읽지 못했습니다`,
  TranscriptDecompressFailed: msg`압축된 기록을 풀지 못했습니다`,
  ImportStoreFailed: msg`기억 저장소에 쓰지 못했습니다`,
  BulkWriteFailed: msg`기억 저장소에 쓰지 못했습니다`,
  SqlError: msg`기억 저장소에 쓰지 못했습니다`,
  Defect: msg`예상하지 못한 오류가 났습니다`,
  Interrupted: msg`가져오기가 중단됐습니다`,
} satisfies Record<typeof ImportFailureTag.Type, MessageDescriptor>;
const PlatformFailureReason = Schema.Literals(["NotFound", "PermissionDenied"]);
const platformFailureTexts = {
  NotFound: msg`파일을 찾지 못했습니다`,
  PermissionDenied: msg`파일을 읽을 권한이 없습니다`,
} satisfies Record<typeof PlatformFailureReason.Type, MessageDescriptor>;

const crashReasons = {
  start: msg`가져오기 작업을 시작하지 못했습니다`,
  count: msg`기록 수를 세지 못했습니다`,
  pass: msg`기록을 읽다가 실패했습니다`,
  lost: msg`가져오기 작업이 끊겼습니다`,
} satisfies Record<Data.TaggedEnum.Value<ImportActivity, "crashed">["reason"], MessageDescriptor>;

const importFailurePart = (part: string) => {
  const [tag, reason] = part.split(":");
  if (tag === "PlatformError" && Schema.is(PlatformFailureReason)(reason))
    return i18n._(platformFailureTexts[reason]);
  return Schema.is(ImportFailureTag)(tag)
    ? i18n._(importFailureTexts[tag])
    : t`가져오지 못했습니다`;
};
/**
 * A recorded import failure in words. Anything else, such as text an older build stored, reads
 * generically: it can hold paths or transcript content.
 */
const importFailureText = (failure: string) =>
  Arr.dedupe(failure.split(",").map(importFailurePart)).join(", ");

/** How often the page asks again while a pass reads, and while its nodes wait to be indexed. */
/** The pass this server is running, or how its latest one went. */
function ImportActivityLine({ activity }: { activity: ImportActivity }) {
  const { t } = useLingui();
  return ImportActivity.$match(activity, {
    running: (activity) => (
      <FieldDescription className="flex items-center">
        <Spinner className="mr-1.5" />
        <span>
          <Trans>
            기록을 읽는 중입니다. <AnimatedNumber value={activity.checked} />/
            <AnimatedNumber value={activity.total} />
            개를 확인하고 노드 <AnimatedNumber value={activity.written} />
            개를 더했습니다.
          </Trans>
          {activity.failed > 0 && (
            <>
              {" "}
              <Trans>
                <AnimatedNumber value={activity.failed} />
                개는 읽지 못했습니다.
              </Trans>
            </>
          )}
        </span>
      </FieldDescription>
    ),
    finished: ({ finishedAt, checked, written, failed }) => {
      const time = timeOfDay(finishedAt);
      return (
        <FieldDescription>
          <Trans>
            {time}에 기록 {checked}개를 확인하고 노드 {written}개를 더했습니다.
          </Trans>
          {failed > 0 && (
            <>
              {" "}
              <Trans>{failed}개는 읽지 못했습니다.</Trans>
            </>
          )}
        </FieldDescription>
      );
    },
    crashed: ({ finishedAt, reason: code }) => {
      const time = timeOfDay(finishedAt);
      const reason = t(crashReasons[code]);
      return (
        <FieldError>
          <Trans>
            {time}에 가져오기가 중간에 멈췄습니다: {reason}
          </Trans>
        </FieldError>
      );
    },
  });
}

/** Migrating other coding agents' local conversations into this app's memory. */
export function ImportSettings() {
  const { t } = useLingui();
  const mutation = useImportMutation();
  const { data: overview } = useImportsQuery();
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const reading = ImportActivity.$is("running")(overview.activity);

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const apply = (command: ImportCommand) =>
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
      title={t(pageTitles.imports)}
      description={
        <Trans>
          Claude Code와 Codex CLI가 이 컴퓨터에 남긴 대화를 기억으로 옮깁니다. 도구 호출과 결과까지
          옮겨서 옛 대화도 근거를 따라갈 수 있습니다. 원본 파일은 읽기만 합니다.
        </Trans>
      }
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={busy || reading}
          onClick={() => void apply(ImportCommand.run())}
        >
          {busy || reading ? <Spinner /> : <RefreshCwIcon />}
          {reading ? (
            <Trans comment="Import button label while an import pass is reading">읽는 중</Trans>
          ) : (
            <Trans comment="Button that starts importing conversations now">지금 가져오기</Trans>
          )}
        </Button>
      }
    />
  );
  return (
    <FieldGroup>
      {header}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="imports-enabled">
            <Trans comment="Switch label: keep importing new conversations in the background">
              계속 가져오기
            </Trans>
          </FieldLabel>
          <FieldDescription>
            <Trans>
              5분마다 새로 쌓인 대화를 이어서 읽습니다. 켤 때 지금 있는 기록을 한 번 읽습니다.
            </Trans>
          </FieldDescription>
        </FieldContent>
        <Switch
          id="imports-enabled"
          checked={overview.enabled}
          disabled={busy}
          onCheckedChange={(checked) =>
            void apply(checked ? ImportCommand.enable() : ImportCommand.disable())
          }
        />
      </Field>
      {overview.enabled && overview.watch !== null && (
        <LoopHealthStatus
          label={t({
            message: "감시",
            comment: "Name of the background loop that watches for new conversations to import",
          })}
          health={overview.watch}
          disabled={busy}
          onRestart={() => void apply(ImportCommand.restart_watch())}
        />
      )}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="imports-interpret">
            <Trans>가져온 발언도 해석</Trans>
          </FieldLabel>
          <FieldDescription>
            <Trans>
              주제를 붙이고 정정, 취소 관계를 정리합니다. 모델을 쓰기 때문에 답변이 끝난 뒤 조금씩
              처리됩니다.
            </Trans>
          </FieldDescription>
        </FieldContent>
        <Switch
          id="imports-interpret"
          checked={overview.interpret}
          disabled={busy}
          onCheckedChange={(checked) => void apply(ImportCommand.interpret({ interpret: checked }))}
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
                <Trans>
                  기록 <AnimatedNumber value={source.transcripts} />
                  개 중 <AnimatedNumber value={source.migrated} />
                  개를 읽어 노드 <AnimatedNumber value={source.nodes} />
                  개를 넣었습니다.
                </Trans>
                {source.failed > 0 && (
                  <>
                    {" "}
                    <Trans>{ph({ failed: source.failed })}개는 읽지 못했습니다.</Trans>
                  </>
                )}
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
          <Trans>
            아직 <AnimatedNumber value={overview.unindexed} />
            개를 인덱싱하고 있습니다. 최근 대화부터 채웁니다. 그동안에도 글자 검색과 형태소
            검색으로는 찾을 수 있습니다.
          </Trans>
        </FieldDescription>
      )}

      <FieldDescription>
        <Trans>
          대화가 있던 폴더는 프로젝트로 등록됩니다. 에이전트가 그 폴더의 파일을 읽고 고칠 수 있게
          됩니다. 필요 없는 프로젝트는 사이드바에서 목록에서 빼 주십시오.
        </Trans>
      </FieldDescription>

      {overview.unplaced.length > 0 && (
        <Alert>
          <AlertDescription>
            <div className="mb-1">
              <Trans>아래 폴더는 프로젝트로 만들 수 없어 가져오지 않았습니다.</Trans>
            </div>
            <ul className="font-mono text-xs">
              {overview.unplaced.map((folder) => (
                <li key={`${folder.cwd}:${folder.reason}`}>
                  <Trans comment="A folder that could not become a project: its path, how many conversations it holds, and why">
                    {ph({ cwd: folder.cwd })}: 대화 {ph({ transcripts: folder.transcripts })}개,{" "}
                    {ph({ reason: unplacedReason(folder.reason) })}
                  </Trans>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {overview.failures.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <div className="mb-1">
              <Trans>아래 기록은 읽지 못했습니다. 다음에 읽을 때 다시 시도합니다.</Trans>
            </div>
            <ul className="font-mono text-xs">
              {overview.failures.map((failure) => (
                <li key={`${failure.source}:${failure.path}`}>
                  {failure.path}: {importFailureText(failure.reason)}
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
