import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Effect } from "effect";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useLoading } from "react-simplikit";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { cn } from "cn";
import { api, isApiError } from "../api";
import { ApprovalCard } from "./approval";
import { chatCopy } from "./copy";
import type { PendingApproval } from "./pending-approval";
import type { AnswerProblem } from "./use-agent-chat";

/** What the alert says for each problem, and what its button does. */
const problems = chatCopy.chatApprovals.problems;

/** Answers the approvals a run waits for together, once every one has a decision. */
export function ChatApprovals({
  sessionId,
  holder,
  approvals,
  problem,
  readOnly,
  resuming,
  onResolve,
  onResync,
  onProblem,
}: {
  sessionId: string;
  holder: string;
  approvals: readonly PendingApproval[];
  problem: AnswerProblem | null;
  readOnly: boolean;
  resuming: boolean;
  onResolve: (decisions: Readonly<Record<string, boolean>>) => void;
  onResync: () => void;
  onProblem: (message: string) => void;
}) {
  const [decisions, setDecisions] = useState<Readonly<Record<string, boolean>>>({});
  const [discarding, trackDiscard] = useLoading();

  const answer = (id: string, approved: boolean) => {
    const next = { ...decisions, [id]: approved };
    setDecisions(next);
    if (approvals.every((approval) => next[approval.id] !== undefined)) onResolve(next);
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const discard = () =>
    runUiEffect(
      uiPromise(() => trackDiscard(api.discardInterrupts(sessionId, holder))).pipe(
        Effect.tap(() => Effect.sync(onResync)),
        Effect.catchTag("UnknownError", (failure) =>
          Effect.sync(() =>
            onProblem(
              isApiError(failure.cause) && failure.cause.code === "run_in_progress"
                ? chatCopy.chatApprovals.discardWhileRunning
                : chatCopy.chatApprovals.discardFailed,
            ),
          ),
        ),
      ),
    );
  const actions = {
    unsent: () => onResolve(decisions),
    refused: onResync,
    lost: () => void discard(),
  } satisfies Record<AnswerProblem, () => void>;

  return (
    <>
      {problem !== null && (
        <Alert variant="destructive">
          <AlertTitle>{chatCopy.chatApprovals.title}</AlertTitle>
          <AlertDescription>
            <div className="flex flex-col items-start gap-3">
              <p>{problems[problem].text}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly || resuming || discarding}
                onClick={actions[problem]}
              >
                <RefreshCwIcon
                  className={cn("size-3.5", (resuming || discarding) && "animate-spin")}
                />
                {problems[problem].action}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          decision={decisions[approval.id]}
          disabled={readOnly || resuming || problem !== null}
          onAnswer={(approved) => answer(approval.id, approved)}
        />
      ))}
    </>
  );
}
