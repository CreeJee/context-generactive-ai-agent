import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { useMutation } from "@tanstack/react-query";
import { useBooleanState } from "react-simplikit";
import { api, isApiError } from "../api";
import { ApprovalChoice, chooseCrossProviderApproval } from "./cross-provider-approval";
import { useImageSettingsQuery } from "../queries/global";
import { useCrossProviderConsentMutation } from "../queries/mutations/global";

/** Image requests and consent are one user action; the settings snapshot belongs to the query cache. */
export function useImageGeneration(onProblem: (message: string) => void) {
  const [intent, _setIntent, clearIntent, toggleIntent] = useBooleanState(false);
  const consentMutation = useCrossProviderConsentMutation();
  const settings = useImageSettingsQuery().data ?? null;
  const generation = useMutation({
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    mutationFn: (prompt: string) =>
      runUiEffect(
        uiPromise(() => api.generateImage(prompt, true)).pipe(
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
                  uiPromise(() => api.generateImage(prompt, true, chosen)),
                always: () =>
                  uiPromise(() => consentMutation.mutateAsync("always")).pipe(
                    Effect.andThen(uiPromise(() => api.generateImage(prompt, true))),
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
          Effect.catchTag("UnknownError", () =>
            Effect.sync(() => {
              onProblem("이미지를 생성하지 못했어요. 설정과 계정 권한을 확인해 주세요.");
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
    asset: generation.isPending ? null : (generation.data ?? null),
    generate,
  };
}
