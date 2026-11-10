import { refusalOf } from "../../api";
import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useConversationSettingsQuery } from "../../queries/global";
import { useConversationSettingsMutation } from "../../queries/mutations/global";
import { errorMessage, PageHeader, PageError } from "../shared";
import { settingsCopy } from "../copy";

const copy = settingsCopy.conversation;

/** Below the share where the oldest messages are left out, so summaries are ready first. */
const maximumPercent = 50;

const validPercent = (text: string) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= maximumPercent ? value : null;
};

/** When a long conversation starts being sent as summaries of its earlier turns. */
export function ConversationSettings() {
  const { data: settings } = useConversationSettingsQuery();
  const mutation = useConversationSettingsMutation();
  const [draft, setDraft] = useState(String(settings.summaryStartPercent));
  const [error, setError] = useState<string | null>(null);
  const percent = validPercent(draft);
  const busy = mutation.isPending;

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const save = (summaryStartPercent: number) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync({ summaryStartPercent })).pipe(
          Effect.catchTag("UnknownError", (failure) =>
            Effect.sync(() => setError(errorMessage(refusalOf(failure.cause)))),
          ),
        );
      }),
    );

  return (
    <FieldGroup>
      <PageHeader title={settingsCopy.titles.conversation} description={copy.description} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (percent !== null) void save(percent);
        }}
      >
        <Field>
          <FieldLabel htmlFor="summary-start-percent">{copy.startLabel}</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="summary-start-percent"
              type="number"
              inputMode="numeric"
              min={0}
              max={maximumPercent}
              step={5}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="w-24"
            />
            <Button
              type="submit"
              disabled={busy || percent === null || percent === settings.summaryStartPercent}
            >
              {busy && <Spinner />} {settingsCopy.shared.save}
            </Button>
          </div>
          <FieldDescription>{copy.startHelp(maximumPercent)}</FieldDescription>
        </Field>
      </form>
      <PageError error={error} />
    </FieldGroup>
  );
}
