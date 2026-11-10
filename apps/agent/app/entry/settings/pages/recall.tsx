import { refusalOf } from "../../api";
import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { useState } from "react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import { Switch } from "~/components/ui/switch";
import type { RecallSettings as Recall } from "../../api";
import { useRecallSettingsQuery } from "../../queries/global";
import { useRecallSettingsMutation } from "../../queries/mutations/global";
import { errorMessage, PageHeader, PageError } from "../shared";
import { settingsCopy } from "../copy";

const copy = settingsCopy.recall;

/** Which memory a conversation may reach beyond its own project. Both start off. */
export function RecallSettings() {
  const { data: settings } = useRecallSettingsQuery();
  const mutation = useRecallSettingsMutation();
  const [error, setError] = useState<string | null>(null);

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const save = (patch: Partial<Recall>) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync(patch)).pipe(
          Effect.catchTag("UnknownError", (failure) =>
            Effect.sync(() => setError(errorMessage(refusalOf(failure.cause)))),
          ),
        );
      }),
    );

  return (
    <FieldGroup>
      <PageHeader title={settingsCopy.titles.recall} description={copy.description} />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="cross-project-recall">{copy.crossProjectLabel}</FieldLabel>
          <FieldDescription>{copy.crossProjectHelp}</FieldDescription>
        </FieldContent>
        <Switch
          id="cross-project-recall"
          checked={settings.crossProjectRecall}
          disabled={mutation.isPending}
          onCheckedChange={(checked) => void save({ crossProjectRecall: checked })}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="external-agent-memory">{copy.externalAgentLabel}</FieldLabel>
          <FieldDescription>{copy.externalAgentHelp}</FieldDescription>
        </FieldContent>
        <Switch
          id="external-agent-memory"
          checked={settings.externalAgentMemory}
          disabled={mutation.isPending}
          onCheckedChange={(checked) => void save({ externalAgentMemory: checked })}
        />
      </Field>
      <PageError error={error} />
    </FieldGroup>
  );
}
