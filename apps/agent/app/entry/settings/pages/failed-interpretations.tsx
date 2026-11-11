import { Trans } from "@lingui/react/macro";
import { Effect } from "effect";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldTitle } from "~/components/ui/field";
import { Spinner } from "~/components/ui/spinner";
import { refusalOf } from "../../api";
import { useInterpretationQuery } from "../../queries/global";
import { useRetryInterpretationMutation } from "../../queries/mutations/global";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { errorMessage, PageError } from "../shared";

/**
 * The user statements memory interpretation left failed, with a button that queues them again.
 * Nothing while none is left, or before the count is read.
 */
export function FailedInterpretations() {
  const { data } = useInterpretationQuery();
  const retry = useRetryInterpretationMutation();
  const [error, setError] = useState<string | null>(null);
  if (data === undefined || data.failed === 0) return null;
  const { failed } = data;

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const retryAll = () =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => retry.mutateAsync()).pipe(
          Effect.catchTag("UnknownError", (failure) =>
            Effect.sync(() => setError(errorMessage(refusalOf(failure.cause)))),
          ),
        );
      }),
    );

  return (
    <>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            <Trans comment="Count of user statements the memory interpreter could not label">
              해석하지 못한 발언 {failed}개
            </Trans>
          </FieldTitle>
          <FieldDescription>
            <Trans>
              모델이 주제와 정정 관계를 붙이지 못한 발언입니다. 그래서 기억 검색이 이미 정정된 옛
              내용을 그대로 보일 수 있습니다. 다시 시도하면 답변이 끝날 때마다 조금씩 다시
              해석합니다.
            </Trans>
          </FieldDescription>
        </FieldContent>
        <Button
          variant="outline"
          size="sm"
          disabled={retry.isPending}
          onClick={() => void retryAll()}
        >
          {retry.isPending ? <Spinner /> : <RefreshCwIcon />}{" "}
          <Trans comment="Button that queues the failed statements for interpretation again">
            다시 시도
          </Trans>
        </Button>
      </Field>
      <PageError error={error} />
    </>
  );
}
