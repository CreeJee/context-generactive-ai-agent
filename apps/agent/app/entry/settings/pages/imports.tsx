import { Array as Arr, Effect } from "effect";
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
import { errorMessage, PageHeader, PageError, shortPath } from "../shared";
import { LoopHealthStatus } from "../../shared/loop-health";
import { settingsCopy } from "../copy";

const copy = settingsCopy.imports;

const sourceNames = { "claude-code": "Claude Code", codex: "Codex CLI" } as const;

/** Why registering a recorded working directory as a project did not work. */
const UnplacedReason = Schema.Literals([
  "not_found",
  "not_directory",
  "overlaps_storage",
  "no_session_line",
  "no_project",
]);
const unplacedReasons = copy.unplaced satisfies Record<typeof UnplacedReason.Type, string>;
const isUnplacedReason = Schema.is(UnplacedReason);

/** A reason this build does not know yet is shown as it came, rather than hidden. */
const unplacedReason = (reason: string) =>
  isUnplacedReason(reason) ? unplacedReasons[reason] : reason;

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
const importFailureTexts = copy.failures satisfies Record<typeof ImportFailureTag.Type, string>;
const PlatformFailureReason = Schema.Literals(["NotFound", "PermissionDenied"]);
const platformFailureTexts = copy.platformFailures satisfies Record<
  typeof PlatformFailureReason.Type,
  string
>;

const importFailurePart = (part: string) => {
  const [tag, reason] = part.split(":");
  if (tag === "PlatformError" && Schema.is(PlatformFailureReason)(reason))
    return platformFailureTexts[reason];
  return Schema.is(ImportFailureTag)(tag) ? importFailureTexts[tag] : copy.failureOther;
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
  return ImportActivity.$match(activity, {
    running: (activity) => (
      <FieldDescription className="flex items-center">
        <Spinner className="mr-1.5" />
        <span>
          {copy.running.reading} <AnimatedNumber value={activity.checked} />/
          <AnimatedNumber value={activity.total} />
          {copy.running.checked} <AnimatedNumber value={activity.written} />
          {copy.running.written}
          {activity.failed > 0 && (
            <>
              {" "}
              <AnimatedNumber value={activity.failed} />
              {copy.unreadAfter}
            </>
          )}
        </span>
      </FieldDescription>
    ),
    finished: (activity) => (
      <FieldDescription>
        {copy.finished(timeOfDay(activity.finishedAt), activity.checked, activity.written)}
        {activity.failed > 0 && ` ${copy.unread(activity.failed)}`}
      </FieldDescription>
    ),
    crashed: (activity) => (
      <FieldError>
        {copy.crashed(timeOfDay(activity.finishedAt), copy.crashReasons[activity.reason])}
      </FieldError>
    ),
  });
}

/** Migrating other coding agents' local conversations into this app's memory. */
export function ImportSettings() {
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
      title={settingsCopy.titles.imports}
      description={copy.description}
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={busy || reading}
          onClick={() => void apply(ImportCommand.run())}
        >
          {busy || reading ? <Spinner /> : <RefreshCwIcon />}
          {reading ? copy.reading : copy.importNow}
        </Button>
      }
    />
  );
  return (
    <FieldGroup>
      {header}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="imports-enabled">{copy.keepImportingLabel}</FieldLabel>
          <FieldDescription>{copy.keepImportingHelp}</FieldDescription>
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
          label={copy.watch}
          health={overview.watch}
          disabled={busy}
          onRestart={() => void apply(ImportCommand.restart_watch())}
        />
      )}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="imports-interpret">{copy.interpretLabel}</FieldLabel>
          <FieldDescription>{copy.interpretHelp}</FieldDescription>
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
                {copy.source.transcripts} <AnimatedNumber value={source.transcripts} />
                {copy.source.migrated} <AnimatedNumber value={source.migrated} />
                {copy.source.nodes} <AnimatedNumber value={source.nodes} />
                {copy.source.written}
                {source.failed > 0 && ` ${copy.unread(source.failed)}`}
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
          {copy.unindexed.before} <AnimatedNumber value={overview.unindexed} />
          {copy.unindexed.after}
        </FieldDescription>
      )}

      <FieldDescription>{copy.projectsNote}</FieldDescription>

      {overview.unplaced.length > 0 && (
        <Alert>
          <AlertDescription>
            <div className="mb-1">{copy.unplacedTitle}</div>
            <ul className="font-mono text-xs">
              {overview.unplaced.map((folder) => (
                <li key={`${folder.cwd}:${folder.reason}`}>
                  {copy.unplacedFolder(
                    folder.cwd,
                    folder.transcripts,
                    unplacedReason(folder.reason),
                  )}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {overview.failures.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <div className="mb-1">{copy.failuresTitle}</div>
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
