import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Effect } from "effect";
import { TriangleAlertIcon } from "lucide-react";
import { useLoading } from "react-simplikit";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { api, isApiError, type UncertainRun } from "../api";
import { chatCopy } from "./copy";

const copy = chatCopy.uncertainRuns;
const stateLabels = copy.states;

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
                ? copy.whileRunning
                : isApiError(failure.cause) && failure.cause.code === "uncertain_runs_changed"
                  ? copy.listChanged
                  : copy.continueFailed,
            );
          }),
        ),
      ),
    );

  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <div className="flex flex-col items-start gap-3">
          <p>{copy.body}</p>
          {tools.length > 0 ? (
            <ul className="flex w-full flex-col gap-1.5">
              {tools.map((tool, index) => (
                <li key={tool.toolCallId ?? index} className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {tool.name ?? copy.unknownTool} · {stateLabels[tool.state]}
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
            <p>{copy.noToolRecord}</p>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={readOnly || continuing}
            onClick={() => void continuePast()}
          >
            {copy.continue}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
