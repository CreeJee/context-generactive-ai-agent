import { Function as EffectFunction } from "effect";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { api, type ProviderId, type SubscriptionAccountProvider } from "../api";
import { appQueryKeys } from "./keys";

export const globalQueries = {
  auth: (provider: ProviderId) =>
    queryOptions({
      queryKey: [...appQueryKeys.global.auth, provider],
      queryFn: () => api.auth(provider),
      refetchInterval: 60_000,
    }),
  accounts: (provider: SubscriptionAccountProvider) =>
    queryOptions({
      queryKey: appQueryKeys.global.accounts(provider),
      queryFn: () => api.accounts(provider),
      // A pending login completes in another tab; poll only while it waits.
      refetchInterval: (query) => (query.state.data?.login.status === "pending" ? 1_000 : false),
    }),
  accountQuota: (provider: SubscriptionAccountProvider) =>
    queryOptions({
      queryKey: appQueryKeys.global.accountQuota(provider),
      queryFn: () => api.accountQuota(provider),
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
export const useAccountsQuery = (provider: SubscriptionAccountProvider, enabled: boolean) =>
  useQuery({ ...globalQueries.accounts(provider), enabled });
export const useAccountQuotaQuery = (provider: SubscriptionAccountProvider, enabled: boolean) =>
  useQuery({ ...globalQueries.accountQuota(provider), enabled });
export const useProjectsQuery = () => useQuery(globalQueries.projects());
export const useImageSettingsQuery = () => useQuery(globalQueries.imageSettings());
export const useSuspenseImageSettingsQuery = () => useSuspenseQuery(globalQueries.imageSettings());
export const useImportsQuery = () => useSuspenseQuery(globalQueries.imports());
export const useEmbeddingQuery = () => useSuspenseQuery(globalQueries.embedding());
export const useKagiQuery = () => useSuspenseQuery(globalQueries.kagi());
const useModelsQueryBody = (provider: ProviderId, enabled: boolean) =>
  useQuery({ ...globalQueries.models(provider), enabled });
export const useModelsQuery: {
  (enabled: boolean): (provider: ProviderId) => ReturnType<typeof useModelsQueryBody>;
} & typeof useModelsQueryBody = EffectFunction.dual(2, useModelsQueryBody);
