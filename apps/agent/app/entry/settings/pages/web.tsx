import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { isTruthy } from "../../../truthy.ts";
import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
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
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { KagiCommand, type KagiStatus, refusalOf } from "../../api";
import { useKagiQuery } from "../../queries/global";
import { useKagiMutation } from "../../queries/mutations/global";
import { errorMessage, PageHeader, PageError } from "../shared";
import { settingsCopy } from "../copy";

const copy = settingsCopy.web;

function KagiBadge({ status }: { status: KagiStatus }) {
  if (status.enabled) return <Badge>{copy.badge.on}</Badge>;
  if (status.keyRegistered) return <Badge variant="secondary">{copy.badge.off}</Badge>;
  return <Badge variant="outline">{copy.badge.noKey}</Badge>;
}

/** Kagi Search and Extract (R19): a key in the keychain, then an explicit switch. */
export function KagiSettings() {
  const mutation = useKagiMutation();
  const { data: status } = useKagiQuery();
  const [key, setKey] = useState("");
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const apply = (command: KagiCommand) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync(command)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (KagiCommand.$is("register")(command)) setKey("");
            }),
          ),
          Effect.catchTag("UnknownError", (failure) =>
            Effect.sync(() => setError(errorMessage(refusalOf(failure.cause)))),
          ),
        );
      }),
    );

  const header = (
    <PageHeader
      title={settingsCopy.titles.web}
      badge={status && <KagiBadge status={status} />}
      description={copy.description}
    />
  );

  return (
    <FieldGroup>
      {header}
      {status.keyRegistered ? (
        <>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="kagi-enabled">{copy.enabledLabel}</FieldLabel>
              <FieldDescription>{copy.enabledHelp}</FieldDescription>
            </FieldContent>
            <Switch
              id="kagi-enabled"
              checked={status.enabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void apply(checked ? KagiCommand.enable() : KagiCommand.disable())
              }
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>{copy.keyTitle}</FieldTitle>
              <FieldDescription>{copy.keyStored}</FieldDescription>
            </FieldContent>
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={busy}
              onClick={() => void apply(KagiCommand.remove())}
            >
              <Trash2Icon /> {copy.deleteKey}
            </Button>
          </Field>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (isTruthy(key.trim())) void apply(KagiCommand.register({ key }));
          }}
        >
          <Field>
            <FieldLabel htmlFor="kagi-key">{copy.keyTitle}</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="kagi-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={copy.keyPlaceholder}
              />
              <Button type="submit" disabled={busy || !isTruthy(key.trim())}>
                {busy ? <Spinner /> : <KeyRoundIcon />} {settingsCopy.shared.save}
              </Button>
            </div>
            <FieldDescription>{copy.keyHelp}</FieldDescription>
          </Field>
        </form>
      )}
      <PageError error={error} />
    </FieldGroup>
  );
}
