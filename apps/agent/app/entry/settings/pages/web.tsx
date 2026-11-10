import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { isTruthy } from "../../../truthy.ts";
import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
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
import { errorMessage, PageHeader, PageError, pageTitles } from "../shared";

function KagiBadge({ status }: { status: KagiStatus }) {
  if (status.enabled)
    return (
      <Badge>
        <Trans comment="Badge: web search is switched on">켜짐</Trans>
      </Badge>
    );
  if (status.keyRegistered)
    return (
      <Badge variant="secondary">
        <Trans comment="Badge: web search is switched off">꺼짐</Trans>
      </Badge>
    );
  return (
    <Badge variant="outline">
      <Trans comment="Badge: no Kagi API key is registered">키 없음</Trans>
    </Badge>
  );
}

/** Kagi Search and Extract (R19): a key in the keychain, then an explicit switch. */
export function KagiSettings() {
  const { t } = useLingui();
  const mutation = useKagiMutation();
  const { data: status } = useKagiQuery();
  const [key, setKey] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
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
      title={t(pageTitles.web)}
      badge={status && <KagiBadge status={status} />}
      description={
        <Trans>
          켜면 모델이 필요할 때 Kagi로 웹을 검색하고 페이지를 읽습니다. 모든 프로젝트에 적용됩니다.
          호출마다 Kagi 요금이 나갑니다.
        </Trans>
      }
    />
  );

  return (
    <FieldGroup>
      {header}
      {status.keyRegistered ? (
        <>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="kagi-enabled">
                <Trans>검색과 페이지 읽기 사용</Trans>
              </FieldLabel>
              <FieldDescription>
                <Trans>실패해도 다시 시도하지 않습니다. 끄면 다음 호출부터 바로 막힙니다.</Trans>
              </FieldDescription>
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
              <FieldTitle>
                <Trans comment="Field title for the Kagi API key">API 키</Trans>
              </FieldTitle>
              <FieldDescription>
                <Trans>OS 키체인에 저장돼 있습니다. 화면에 다시 보여 주지 않습니다.</Trans>
              </FieldDescription>
            </FieldContent>
            <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
              <AlertDialogTrigger
                render={<Button variant="ghost-muted" size="sm" disabled={busy} />}
              >
                <Trash2Icon />{" "}
                <Trans comment="Button that deletes the stored Kagi API key">키 삭제</Trans>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    <Trans>Kagi API 키를 지울까요?</Trans>
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    <Trans>
                      OS 키체인에서 키를 지우고 웹 검색을 끕니다. 다시 쓰려면 키를 새로 넣어야
                      합니다.
                    </Trans>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    <Trans comment="Dialog button that cancels">취소</Trans>
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => {
                      setConfirmingRemove(false);
                      void apply(KagiCommand.remove());
                    }}
                  >
                    <Trans comment="Dialog button that confirms deleting the Kagi API key">
                      키 삭제
                    </Trans>
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
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
            <FieldLabel htmlFor="kagi-key">
              <Trans comment="Field title for the Kagi API key">API 키</Trans>
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                id="kagi-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={t`kagi.com/api/keys에서 발급한 키`}
              />
              <Button type="submit" disabled={busy || !isTruthy(key.trim())}>
                {busy ? <Spinner /> : <KeyRoundIcon />}{" "}
                <Trans comment="Button that saves a settings field">저장</Trans>
              </Button>
            </div>
            <FieldDescription>
              <Trans>
                키는 OS 키체인에만 저장되고 모델, 대화, 로그에는 보이지 않습니다. 저장해도 저절로
                켜지지는 않습니다.
              </Trans>
            </FieldDescription>
          </Field>
        </form>
      )}
      <PageError error={error} />
    </FieldGroup>
  );
}
