import { Function as EffectFunction } from "effect";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { api, type ProviderId, type SubscriptionAccountProvider } from "../api";
import { compatibleClient, compatibleQueryKey } from "../navigation/compatible-client";
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
    }),
  compatibleAccounts: () =>
    queryOptions({ queryKey: compatibleQueryKey, queryFn: compatibleClient.list }),
  accountQuota: (provider: SubscriptionAccountProvider) =>
    queryOptions({
      queryKey: appQueryKeys.global.accountQuota(provider),
      queryFn: () => api.accountQuota(provider),
    }),
  projects: () => queryOptions({ queryKey: appQueryKeys.global.projects, queryFn: api.projects }),
  hiddenProjects: () =>
    queryOptions({ queryKey: appQueryKeys.global.hiddenProjects, queryFn: api.hiddenProjects }),
  imports: () => queryOptions({ queryKey: appQueryKeys.global.imports, queryFn: api.imports }),
  embedding: () =>
    queryOptions({ queryKey: appQueryKeys.global.embedding, queryFn: api.embedding }),
  imageSettings: () =>
    queryOptions({ queryKey: appQueryKeys.global.imageSettings, queryFn: api.imageSettings }),
  kagi: () => queryOptions({ queryKey: appQueryKeys.global.kagi, queryFn: api.kagi }),
  conversation: () =>
    queryOptions({
      queryKey: appQueryKeys.global.conversation,
      queryFn: api.conversationSettings,
    }),
  recall: () => queryOptions({ queryKey: appQueryKeys.global.recall, queryFn: api.recallSettings }),
  kanban: () => queryOptions({ queryKey: appQueryKeys.global.kanban, queryFn: api.kanbanSettings }),
  models: (provider: ProviderId) =>
    queryOptions({
      queryKey: appQueryKeys.global.models(provider),
      queryFn: () => api.models(provider),
    }),
};

export const useAuthQuery = (provider: ProviderId) => useQuery(globalQueries.auth(provider));
const useAccountsQueryBody = (provider: SubscriptionAccountProvider, enabled: boolean) =>
  useQuery({ ...globalQueries.accounts(provider), enabled });
export const useAccountsQuery: {
  (
    enabled: boolean,
  ): (provider: SubscriptionAccountProvider) => ReturnType<typeof useAccountsQueryBody>;
} & typeof useAccountsQueryBody = EffectFunction.dual(2, useAccountsQueryBody);
export const useCompatibleAccountsQuery = () => useQuery(globalQueries.compatibleAccounts());
const useAccountQuotaQueryBody = (provider: SubscriptionAccountProvider, enabled: boolean) =>
  useQuery({ ...globalQueries.accountQuota(provider), enabled });
export const useAccountQuotaQuery: {
  (
    enabled: boolean,
  ): (provider: SubscriptionAccountProvider) => ReturnType<typeof useAccountQuotaQueryBody>;
} & typeof useAccountQuotaQueryBody = EffectFunction.dual(2, useAccountQuotaQueryBody);
export const useProjectsQuery = () => useQuery(globalQueries.projects());
export const useHiddenProjectsQuery = () => useQuery(globalQueries.hiddenProjects());
export const useImageSettingsQuery = () => useQuery(globalQueries.imageSettings());
export const useSuspenseImageSettingsQuery = () => useSuspenseQuery(globalQueries.imageSettings());
export const useImportsQuery = () => useSuspenseQuery(globalQueries.imports());
export const useEmbeddingQuery = () => useSuspenseQuery(globalQueries.embedding());
export const useKagiQuery = () => useSuspenseQuery(globalQueries.kagi());
export const useConversationSettingsQuery = () => useSuspenseQuery(globalQueries.conversation());
export const useRecallSettingsQuery = () => useSuspenseQuery(globalQueries.recall());
export const useKanbanSettingsQuery = () => useSuspenseQuery(globalQueries.kanban());
const useModelsQueryBody = (provider: ProviderId, enabled: boolean) =>
  useQuery({ ...globalQueries.models(provider), enabled });
export const useModelsQuery: {
  (enabled: boolean): (provider: ProviderId) => ReturnType<typeof useModelsQueryBody>;
} & typeof useModelsQueryBody = EffectFunction.dual(2, useModelsQueryBody);
