import { Match } from "effect";
import type { AttemptFailure } from "memory-agent";
import { sessionCopy } from "./copy";

const { stage: stageLabel, reason } = sessionCopy.attemptFailure;

const reasonLabel = Match.type<AttemptFailure["reason"]>().pipe(
  Match.tagsExhaustive({
    ModelRunError: () => reason.ModelRunError,
    ModelStreamFailed: () => reason.ModelStreamFailed,
    RepeatedToolCall: () => reason.RepeatedToolCall,
    ContextLimitExceeded: () => reason.ContextLimitExceeded,
    AgentCrashed: () => reason.AgentCrashed,
    HeartbeatLost: () => reason.HeartbeatLost,
    ServerRestarted: () => reason.ServerRestarted,
    ExternalAgentFailed: ({ code }) => reason.ExternalAgentFailed(code),
    ProcessExited: ({ exitCode, signal }) =>
      signal === null
        ? reason.ProcessExited.exitCode(exitCode)
        : reason.ProcessExited.signal(signal),
    ProcessTimedOut: () => reason.ProcessTimedOut,
    OperationFailed: () => reason.OperationFailed,
    ResultStorageFailed: () => reason.ResultStorageFailed,
  }),
);

/** One line for the user: what went wrong and at which stage. Only the recorded code is shown. */
export const failureLabel = (failure: AttemptFailure) =>
  `${reasonLabel(failure.reason)} · ${stageLabel[failure.stage]}`;
