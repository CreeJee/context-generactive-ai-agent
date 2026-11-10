import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Effect } from "effect";
import { TriangleAlertIcon } from "lucide-react";
import { useLoading } from "react-simplikit";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { api, isApiError, type UncertainRun, type UncertainTool } from "../api";

const stateLabels = {
  pending: msg`실행 결과를 받지 못함`,
  uncertain: msg`실행됐는지 알 수 없음`,
  rejected: msg`도중에 실패함`,
  unrecorded: msg`실행됐지만 결과가 기록되지 않음`,
} satisfies Record<UncertainTool["state"], MessageDescriptor>;

/**
 * Ended Goal runs whose tools left their outcome unknown. A new run waits until the user checks
 * what those tools may have done and chooses to continue; nothing is run again for them.
 */
export function UncertainRuns({
  sessionId,
  holder,
  runs,
  readOnly,
  onContinued,
  onProblem,
}: {
  sessionId: string;
  holder: string;
  runs: readonly UncertainRun[];
  readOnly: boolean;
  onContinued: () => void;
  onProblem: (message: string) => void;
}) {
  const { t } = useLingui();
  const [continuing, trackContinue] = useLoading();
  if (runs.length === 0) return null;
  const tools = runs.flatMap((run) => run.tools);

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const continuePast = () =>
    runUiEffect(
      uiPromise(() =>
        trackContinue(
          api.continuePastUncertain(
            sessionId,
            holder,
            runs.map((run) => run.runId),
          ),
        ),
      ).pipe(
        Effect.tap(() => Effect.sync(onContinued)),
        Effect.catchTag("UnknownError", (failure) =>
          Effect.sync(() => {
            if (isApiError(failure.cause) && failure.cause.code === "uncertain_runs_changed")
              onContinued();
            onProblem(
              isApiError(failure.cause) && failure.cause.code === "run_in_progress"
                ? t`실행 중인 작업이 끝난 뒤 다시 시도해 주십시오.`
                : isApiError(failure.cause) && failure.cause.code === "uncertain_runs_changed"
                  ? t`확인할 목록이 바뀌었습니다. 새 목록을 확인해 주십시오.`
                  : t`이어서 진행하지 못했습니다.`,
            );
          }),
        ),
      ),
    );

  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>
        <Trans>이전 실행의 결과를 확인해 주십시오</Trans>
      </AlertTitle>
      <AlertDescription>
        <div className="flex flex-col items-start gap-3">
          <p>
            <Trans>
              Goal 실행이 끝나기 전에 멈춰서 아래 도구가 무엇을 바꿨는지 알 수 없습니다. 확인 없이
              이어가면 같은 작업을 다시 할 수 있어서 새 실행을 멈춰 두었습니다. 직접 확인한 뒤
              이어가 주십시오. 이 도구들은 다시 실행되지 않습니다.
            </Trans>
          </p>
          {tools.length > 0 ? (
            <ul className="flex w-full flex-col gap-1.5">
              {tools.map((tool, index) => (
                <li key={tool.toolCallId ?? index} className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {tool.name ?? t`알 수 없는 도구`} · {t(stateLabels[tool.state])}
                  </span>
                  {tool.call !== null && (
                    <code className="line-clamp-3 text-xs break-all whitespace-pre-wrap text-muted-foreground">
                      {tool.call}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>
              <Trans>도구 기록이 남기 전에 멈춘 실행입니다.</Trans>
            </p>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={readOnly || continuing}
            onClick={() => void continuePast()}
          >
            <Trans>확인했으니 이어서 진행</Trans>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
