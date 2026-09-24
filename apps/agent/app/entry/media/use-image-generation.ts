import { useMutation } from "@tanstack/react-query";
import { useBooleanState } from "react-simplikit";
import { api, ApiError } from "../api";
import { chooseCrossProviderApproval } from "./cross-provider-approval";
import { useImageSettingsQuery } from "../queries/global";
import { useCrossProviderConsentMutation } from "../queries/mutations/global";

/** Image requests and consent are one user action; the settings snapshot belongs to the query cache. */
export function useImageGeneration(onProblem: (message: string) => void) {
  const [intent, _setIntent, clearIntent, toggleIntent] = useBooleanState(false);
  const consentMutation = useCrossProviderConsentMutation();
  const settings = useImageSettingsQuery().data ?? null;
  const generation = useMutation({
    mutationFn: async (prompt: string) => {
      try {
        return await api.generateImage(prompt, true);
      } catch (failure) {
        const choice =
          failure instanceof ApiError &&
          failure.code === "image_approval_required" &&
          failure.reason === "cross_provider" &&
          failure.approval
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
