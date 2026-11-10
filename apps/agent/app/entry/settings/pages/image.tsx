import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
import { PageHeader, pageTitles } from "../shared";

const consentModes = {
  disabled: msg({
    message: "사용 안 함",
    comment: "Option: never send image prompts from Claude to OpenAI",
  }),
  ask: msg({ message: "매번 확인", comment: "Option: ask before each cross-provider image run" }),
  always: msg({ message: "항상 허용", comment: "Option: always allow cross-provider image runs" }),
} satisfies Record<CrossProviderMediaConsentMode, MessageDescriptor>;

function isCrossProviderMediaConsentMode(
  value: string | null,
): value is CrossProviderMediaConsentMode {
  return value === "disabled" || value === "ask" || value === "always";
}

export function ImageSettings() {
  const { t } = useLingui();
  const enabledMutation = useImageGenerationEnabledMutation();
  const consentMutation = useCrossProviderConsentMutation();
  const { data: status } = useSuspenseImageSettingsQuery();
  const busy = enabledMutation.isPending || consentMutation.isPending;
  const [error, setError] = useState<string | null>(null);
  // The closed select shows the label of its value, not the raw mode.
  const consentItems = (["disabled", "ask", "always"] as const).map((mode) => ({
    value: mode,
    label: t(consentModes[mode]),
  }));

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const setImageGenerationEnabled = (enabled: boolean) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => enabledMutation.mutateAsync(enabled)).pipe(
          Effect.catchTag("UnknownError", (_failure) =>
            Effect.sync(() => {
              setError(t`이미지 설정을 바꾸지 못했습니다.`);
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
              setError(t`공급자 간 이미지 실행 동의를 바꾸지 못했습니다.`);
            }),
          ),
        );
      }),
    );

  const header = (
    <PageHeader
      title={t(pageTitles.image)}
      badge={
        status && (
          <Badge variant={status.imageGenerationEnabled ? "secondary" : "outline"}>
            {status.imageGenerationEnabled ? (
              <Trans comment="Badge: image generation is switched on">사용 중</Trans>
            ) : (
              <Trans comment="Badge: image generation is switched off">꺼짐</Trans>
            )}
          </Badge>
        )
      }
      description={
        <Trans>
          이미지 생성이 필요할 때만 작성창에서 생성 모드를 선택해 사용합니다. 일반 대화에는 이미지
          도구가 추가되지 않습니다.
        </Trans>
      }
    />
  );

  return (
    <FieldGroup>
      {header}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="image-generation-enabled">
            <Trans>이미지 생성 사용</Trans>
          </FieldLabel>
          <FieldDescription>
            <Trans>
              OpenAI API 키가 필요하며 생성할 때마다 비용이 발생할 수 있습니다. 설정은 바로 적용되고
              앱을 다시 시작할 필요가 없습니다.
            </Trans>
          </FieldDescription>
        </FieldContent>
        <Switch
          id="image-generation-enabled"
          checked={status.imageGenerationEnabled}
          disabled={busy}
          onCheckedChange={(checked) => void setImageGenerationEnabled(checked)}
        />
      </Field>
      <Alert>
        <AlertDescription>
          <Trans>
            켜도 이미지는 자동으로 생성되지 않습니다. 작성창에서 이미지 생성 모드를 선택한 요청만
            처리합니다. 유료 실행 전에는 별도로 확인합니다.
          </Trans>
        </AlertDescription>
      </Alert>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="cross-provider-media">
            <Trans>Claude에서 이미지 생성</Trans>
          </FieldLabel>
          <FieldDescription>
            <Trans>
              Claude 사용 중 이미지 생성을 요청하면 프롬프트를 OpenAI로 보냅니다. 사용량은 OpenAI
              계정에 귀속됩니다. 로그인만으로 자동 허용되지 않습니다.
            </Trans>
          </FieldDescription>
        </FieldContent>
        <Select
          value={
            status.crossProviderMediaConsent.pairs["anthropic->openai:media.image.generate"] ??
            "disabled"
          }
          items={consentItems}
          disabled={busy || !status.imageGenerationEnabled}
          onValueChange={(value) => {
            if (isCrossProviderMediaConsentMode(value)) void applyCrossProviderMode(value);
          }}
        >
          <SelectTrigger id="cross-provider-media" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {consentItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
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
