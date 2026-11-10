import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { type CrossProviderMediaConsentMode } from "../../api";
import { useSuspenseImageSettingsQuery } from "../../queries/global";
import {
  useCrossProviderConsentMutation,
  useImageGenerationEnabledMutation,
} from "../../queries/mutations/global";
import { PageHeader } from "../shared";
import { settingsCopy } from "../copy";

const copy = settingsCopy.image;

function isCrossProviderMediaConsentMode(
  value: string | null,
): value is CrossProviderMediaConsentMode {
  return value === "disabled" || value === "ask" || value === "always";
}

export function ImageSettings() {
  const enabledMutation = useImageGenerationEnabledMutation();
  const consentMutation = useCrossProviderConsentMutation();
  const { data: status } = useSuspenseImageSettingsQuery();
  const busy = enabledMutation.isPending || consentMutation.isPending;
  const [error, setError] = useState<string | null>(null);

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const setImageGenerationEnabled = (enabled: boolean) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => enabledMutation.mutateAsync(enabled)).pipe(
          Effect.catchTag("UnknownError", (_failure) =>
            Effect.sync(() => {
              setError(copy.enabledFailed);
            }),
          ),
        );
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const applyCrossProviderMode = (mode: CrossProviderMediaConsentMode) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => consentMutation.mutateAsync(mode)).pipe(
          Effect.catchTag("UnknownError", (_failure) =>
            Effect.sync(() => {
              setError(copy.consentFailed);
            }),
          ),
        );
      }),
    );

  const header = (
    <PageHeader
      title={settingsCopy.titles.image}
      badge={
        status && (
          <Badge variant={status.imageGenerationEnabled ? "secondary" : "outline"}>
            {status.imageGenerationEnabled ? copy.badge.on : copy.badge.off}
          </Badge>
        )
      }
      description={copy.description}
    />
  );

  return (
    <FieldGroup>
      {header}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="image-generation-enabled">{copy.enabledLabel}</FieldLabel>
          <FieldDescription>{copy.enabledHelp}</FieldDescription>
        </FieldContent>
        <Switch
          id="image-generation-enabled"
          checked={status.imageGenerationEnabled}
          disabled={busy}
          onCheckedChange={(checked) => void setImageGenerationEnabled(checked)}
        />
      </Field>
      <Alert>
        <AlertDescription>{copy.notAutomatic}</AlertDescription>
      </Alert>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="cross-provider-media">{copy.crossProviderLabel}</FieldLabel>
          <FieldDescription>{copy.crossProviderHelp}</FieldDescription>
        </FieldContent>
        <Select
          value={
            status.crossProviderMediaConsent.pairs["anthropic->openai:media.image.generate"] ??
            "disabled"
          }
          disabled={busy || !status.imageGenerationEnabled}
          onValueChange={(value) => {
            if (isCrossProviderMediaConsentMode(value)) void applyCrossProviderMode(value);
          }}
        >
          <SelectTrigger id="cross-provider-media" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">{copy.consentModes.disabled}</SelectItem>
            <SelectItem value="ask">{copy.consentModes.ask}</SelectItem>
            <SelectItem value="always">{copy.consentModes.always}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  );
}
