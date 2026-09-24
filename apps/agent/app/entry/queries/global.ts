import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { api, type ProviderId } from "../api";
import { appQueryKeys } from "./keys";

export const globalQueries = {
  auth: (provider: ProviderId) =>
    queryOptions({
      queryKey: [...appQueryKeys.global.auth, provider],
      queryFn: () => api.auth(provider),
      refetchInterval: 60_000,
    }),
  projects: () => queryOptions({ queryKey: appQueryKeys.global.projects, queryFn: api.projects }),
  imports: () => queryOptions({ queryKey: appQueryKeys.global.imports, queryFn: api.imports }),
  embedding: () =>
    queryOptions({ queryKey: appQueryKeys.global.embedding, queryFn: api.embedding }),
  imageSettings: () =>
    queryOptions({ queryKey: appQueryKeys.global.imageSettings, queryFn: api.imageSettings }),
  kagi: () => queryOptions({ queryKey: appQueryKeys.global.kagi, queryFn: api.kagi }),
  models: (provider: ProviderId) =>
    queryOptions({
      queryKey: appQueryKeys.global.models(provider),
      queryFn: () => api.models(provider),
    }),
};

export const useAuthQuery = (provider: ProviderId) => useQuery(globalQueries.auth(provider));
export const useProjectsQuery = () => useQuery(globalQueries.projects());
export const useImageSettingsQuery = () => useQuery(globalQueries.imageSettings());
export const useSuspenseImageSettingsQuery = () => useSuspenseQuery(globalQueries.imageSettings());
export const useImportsQuery = () => useSuspenseQuery(globalQueries.imports());
export const useEmbeddingQuery = () => useSuspenseQuery(globalQueries.embedding());
export const useKagiQuery = () => useSuspenseQuery(globalQueries.kagi());
export const useModelsQuery = (provider: ProviderId, enabled: boolean) =>
  useQuery({ ...globalQueries.models(provider), enabled });
