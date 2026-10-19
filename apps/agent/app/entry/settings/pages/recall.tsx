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
      <PageHeader
        title="기억 범위"
        description="대화가 지금 프로젝트 밖의 기억을 쓰거나 내보낼지 정해요. 둘 다 처음에는 꺼져 있어요."
      />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="cross-project-recall">다른 프로젝트 기억도 찾기</FieldLabel>
          <FieldDescription>
            켜면 다른 프로젝트의 대화도 함께 찾아요. 사이드바에서 다른 프로젝트 검색을 막아 둔
            프로젝트는 제외돼요.
          </FieldDescription>
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
          <FieldLabel htmlFor="external-agent-memory">외부 에이전트에 기억 보내기</FieldLabel>
          <FieldDescription>
            외부 에이전트와 직접 대화할 때, 메시지와 관련된 기억을 최대 5개까지 출처와 함께 메시지
            앞에 붙여 보내요. 외부 프로세스로 나가는 내용이라 필요할 때만 켜 주세요.
          </FieldDescription>
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
