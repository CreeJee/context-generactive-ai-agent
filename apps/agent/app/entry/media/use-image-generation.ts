import { t } from "@lingui/core/macro";
import { Effect, Match } from "effect";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { useMutation } from "@tanstack/react-query";
import { useBooleanState } from "react-simplikit";
import { api, isApiError, refusalOf } from "../api";
import { ApprovalChoice, chooseCrossProviderApproval } from "./cross-provider-approval";
import { useImageSettingsQuery } from "../queries/global";
import { useCrossProviderConsentMutation } from "../queries/mutations/global";

/** What the user is told when the image was not made, or was made but not written into the conversation. */
const problemText = <F>(failure: F) =>
  Match.value(refusalOf(failure)?.code).pipe(
    Match.when(
      "image_record_failed",
      () => t`이미지를 만들었지만 대화에 적지 못했습니다. 다시 시도해 주십시오.`,
    ),
    Match.when(
      "run_in_progress",
      () => t`이 대화가 아직 답하는 중입니다. 답변이 끝난 뒤 다시 보내 주십시오.`,
    ),
    Match.when("session_in_use", () => t`다른 탭이 이 대화를 쓰고 있습니다.`),
    Match.orElse(() => t`이미지를 생성하지 못했습니다. 설정과 계정 권한을 확인해 주십시오.`),
  );

/** Image requests and consent are one user action; the settings snapshot belongs to the query cache. */
export function useImageGeneration({
  sessionId,
  holder,
  onProblem,
}: {
  sessionId: string;
  holder: string;
  onProblem: (message: string) => void;
}) {
  const [intent, _setIntent, clearIntent, toggleIntent] = useBooleanState(false);
  const consentMutation = useCrossProviderConsentMutation();
  const settings = useImageSettingsQuery().data ?? null;
  const generation = useMutation({
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    mutationFn: (prompt: string) =>
      runUiEffect(
        uiPromise(() => api.generateSessionImage(sessionId, holder, prompt, true)).pipe(
          Effect.catchTag("UnknownError", (rejected) =>
            Effect.gen(function* () {
              const failure = rejected.cause;
              const approval = isApiError(failure) ? failure.approval : undefined;
              const choice =
                isApiError(failure) &&
                failure.code === "image_approval_required" &&
                failure.reason === "cross_provider" &&
                approval !== undefined
                  ? yield* uiPromise(() => chooseCrossProviderApproval(approval))
                  : null;
              if (choice === null) return yield* rejected;
              return yield* ApprovalChoice.$match(choice, {
                cancel: () => Effect.succeed(null),
                once: ({ approval: chosen }) =>
                  uiPromise(() =>
                    api.generateSessionImage(sessionId, holder, prompt, true, chosen),
                  ),
                always: () =>
                  uiPromise(() => consentMutation.mutateAsync("always")).pipe(
                    Effect.andThen(
                      uiPromise(() => api.generateSessionImage(sessionId, holder, prompt, true)),
                    ),
                  ),
              });
            }),
          ),
        ),
      ),
  });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const generate = (prompt: string) =>
    runUiEffect(
      Effect.gen(function* () {
        if (generation.isPending) return false;
        return yield* Effect.gen(function* () {
          return (yield* uiPromise(() => generation.mutateAsync(prompt))) !== null;
        }).pipe(
          Effect.catchTag("UnknownError", (rejected) =>
            Effect.sync(() => {
              onProblem(problemText(rejected.cause));
              return false;
            }),
          ),
        );
      }),
    );

  return {
    intent,
    clearIntent,
    toggleIntent,
    settings,
    generating: generation.isPending,
    generate,
  };
}
