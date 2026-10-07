import { useMutation } from "@tanstack/react-query";
import { useBooleanState } from "react-simplikit";
import { api, isApiError } from "../api";
import { chooseCrossProviderApproval } from "./cross-provider-approval";
import { useImageSettingsQuery } from "../queries/global";
import { useCrossProviderConsentMutation } from "../queries/mutations/global";

/** Image requests and consent are one user action; the settings snapshot belongs to the query cache. */
export function useImageGeneration(onProblem: (message: string) => void) {
  const [intent, _setIntent, clearIntent, toggleIntent] = useBooleanState(false);
  const consentMutation = useCrossProviderConsentMutation();
  const settings = useImageSettingsQuery().data ?? null;
  const generation = useMutation({
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    mutationFn: async (prompt: string) => {
      try {
        return await api.generateImage(prompt, true);
      } catch (failure) {
        const choice =
          isApiError(failure) &&
          failure.code === "image_approval_required" &&
          failure.reason === "cross_provider" &&
          failure.approval !== undefined
            ? await chooseCrossProviderApproval(failure.approval)
            : null;
        if (choice === null) throw failure;
        switch (choice.kind) {
          case "cancel":
            return null;
          case "once":
            return api.generateImage(prompt, true, choice.approval);
          case "always": {
            await consentMutation.mutateAsync("always");
            return api.generateImage(prompt, true);
          }
        }
      }
    },
  });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const generate = async (prompt: string) => {
    if (generation.isPending) return false;
    try {
      return (await generation.mutateAsync(prompt)) !== null;
    } catch {
      onProblem("이미지를 생성하지 못했어요. 설정과 계정 권한을 확인해 주세요.");
      return false;
    }
  };

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
