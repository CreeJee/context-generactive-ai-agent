import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ProviderId } from "../../api";
import { globalQueries } from "../global";
import { appQueryKeys } from "../keys";

/** Each setting response is the complete new server snapshot for its query. */
export function useImageGenerationEnabledMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.setImageGenerationEnabled,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.imageSettings().queryKey }),
  });
}

export function useCrossProviderConsentMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.setCrossProviderMediaConsent,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.imageSettings().queryKey }),
  });
}

export function useKagiMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.kagiAction,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.kagi().queryKey }),
  });
}

export function useImportMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.importAction,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.imports().queryKey }),
  });
}

export function useEmbeddingMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.embeddingAction,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.embedding().queryKey }),
  });
}

export function useAuthActionMutation(provider: ProviderId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (intent: "login" | "cancel" | "logout") => api.authAction(intent, provider),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: globalQueries.auth(provider).queryKey }),
        client.invalidateQueries({ queryKey: appQueryKeys.global.models(provider) }),
      ]);
    },
  });
}

export function useAddProjectMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.addProject,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.projects().queryKey }),
  });
}

export function useSelectModelMutation(provider: ProviderId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ model, effort }: { model: string; effort?: string }) =>
      api.selectModel(model, effort, provider),
    onSuccess: () => client.invalidateQueries({ queryKey: appQueryKeys.global.modelsRoot }),
  });
}
