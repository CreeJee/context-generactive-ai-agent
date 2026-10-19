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
      <PageHeader
        title="긴 대화"
        description="대화가 길어지면 앞쪽 턴을 요약으로 바꿔 보내요. 원문은 기억에 남아 있어서 모델이 필요할 때 다시 읽어요."
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (percent !== null) void save(percent);
        }}
      >
        <Field>
          <FieldLabel htmlFor="summary-start-percent">요약 시작 시점 (컨텍스트 대비 %)</FieldLabel>
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
              variant="outline"
              disabled={busy || percent === null || percent === settings.summaryStartPercent}
            >
              {busy && <Spinner />} 저장
            </Button>
          </div>
          <FieldDescription>
            모델 컨텍스트가 이만큼 찰 때까지는 원문 그대로 보내요. 낮추면 일찍 요약해 짧게 보내고,
            높이면 원문을 오래 보내요. 0이면 처음부터 요약하고, 최대 {maximumPercent}%예요. 다음
            응답부터 적용되고, 이미 요약을 쓰기 시작한 대화는 계속 요약을 써요.
          </FieldDescription>
        </Field>
      </form>
      <PageError error={error} />
    </FieldGroup>
  );
}
