import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, vi } from "vite-plus/test";
import {
  AccountLoginState,
  api,
  ProviderAuthState,
  type ModelSelection,
  type ProviderId,
} from "../../api";
import { uiPromise } from "../../shared/ui-effect";
import { globalQueries } from "../global";
import { useSwitchAccountMutation } from "./global";

type Catalog = Awaited<ReturnType<typeof api.models>>;
const catalog = (provider: ProviderId, id: string, selected: ModelSelection | null): Catalog => ({
  models: [
    {
      provider,
      id,
      displayName: id,
      isDefault: true,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: ["high"],
      capabilities: { inputModalities: ["text"], toolCalling: true, reasoning: true },
    },
  ],
  selected,
});

function switcher(client: QueryClient) {
  const captured: ReturnType<typeof useSwitchAccountMutation>[] = [];
  function Probe() {
    captured.push(useSwitchAccountMutation());
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  return captured[0]!;
}

afterEach(() => vi.restoreAllMocks());

it.live(
  "switches using the new account catalog without waiting for usage or other provider refreshes",
  () =>
    Effect.gen(function* () {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const runPromise = Effect.runPromiseWith(yield* Effect.context());
      const oldSelection: ModelSelection = {
        provider: "openai",
        model: "old",
        reasoningEffort: "high",
      };
      const selection: ModelSelection = {
        provider: "anthropic",
        model: "new-account",
        reasoningEffort: "high",
      };
      const oldCatalog = catalog("openai", "old", oldSelection);
      const newCatalog = catalog("anthropic", "new-account", null);
      const oldRequest = yield* Deferred.make<Catalog>();
      const refresh = yield* Deferred.make<void>();
      const selectEntered = yield* Deferred.make<void>();
      const selectRelease = yield* Deferred.make<ModelSelection>();
      vi.spyOn(api, "accountAction").mockResolvedValue({
        profiles: [],
        login: AccountLoginState.idle(),
      });
      vi.spyOn(api, "accountQuota").mockImplementation(() =>
        runPromise(
          Deferred.await(refresh).pipe(
            Effect.as({ provider: "anthropic", checkedAt: "2026-10-15T00:00:00Z", accounts: [] }),
          ),
        ),
      );
      vi.spyOn(api, "auth").mockImplementation(() =>
        runPromise(
          Deferred.await(refresh).pipe(
            Effect.as(ProviderAuthState["signed-in"]({ provider: "anthropic" })),
          ),
        ),
      );
      let targetRequests = 0;
      vi.spyOn(api, "models").mockImplementation((provider) => {
        if (provider === "anthropic") {
          targetRequests += 1;
          if (targetRequests === 1) return runPromise(Deferred.await(oldRequest));
          if (targetRequests === 2) return Promise.resolve(newCatalog);
        }
        return runPromise(
          Deferred.await(refresh).pipe(
            Effect.as(
              provider === "anthropic"
                ? { ...newCatalog, selected: selection }
                : { ...oldCatalog, selected: null },
            ),
          ),
        );
      });
      vi.spyOn(api, "selectModel").mockImplementation(() =>
        runPromise(
          Deferred.succeed(selectEntered, undefined).pipe(
            Effect.andThen(Deferred.await(selectRelease)),
          ),
        ),
      );
      client.setQueryData(globalQueries.models("openai").queryKey, oldCatalog);
      client.setQueryData(
        globalQueries.models("anthropic").queryKey,
        catalog("anthropic", "previous-account", null),
      );
      const subscriptions = [
        new QueryObserver(client, {
          ...globalQueries.models("openai"),
          staleTime: Infinity,
        }).subscribe(() => {}),
        new QueryObserver(client, globalQueries.models("anthropic")).subscribe(() => {}),
        new QueryObserver(client, {
          ...globalQueries.auth("anthropic"),
          staleTime: Infinity,
          initialData: (): ProviderAuthState =>
            ProviderAuthState["signed-in"]({ provider: "anthropic" }),
        }).subscribe(() => {}),
        new QueryObserver(client, {
          ...globalQueries.accountQuota("anthropic"),
          staleTime: Infinity,
          initialData: { provider: "anthropic", checkedAt: "2026-10-15T00:00:00Z", accounts: [] },
        }).subscribe(() => {}),
      ];
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(refresh, undefined);
          yield* Deferred.succeed(oldRequest, newCatalog);
          yield* Deferred.succeed(selectRelease, selection);
          subscriptions.forEach((unsubscribe) => unsubscribe());
          client.clear();
        }),
      );
      const mutation = switcher(client);
      const switching = yield* Effect.forkChild(
        uiPromise(() =>
          mutation.mutateAsync({
            target: { provider: "anthropic", accountId: "new-account" },
            selectModel: true,
          }),
        ),
      );
      yield* Deferred.await(selectEntered);
      expect(switching.pollUnsafe()).toBeUndefined();
      expect(api.selectModel).toHaveBeenCalledWith("new-account", undefined, "anthropic");
      yield* Deferred.succeed(selectRelease, selection);
      expect(yield* Fiber.join(switching)).toEqual(selection);
      expect(client.getQueryData(globalQueries.models("openai").queryKey)?.selected).toBeNull();
      expect(client.getQueryData(globalQueries.models("anthropic").queryKey)?.selected).toEqual(
        selection,
      );
      expect(
        client.getQueryState(globalQueries.accountQuota("anthropic").queryKey)?.fetchStatus,
      ).toBe("fetching");
      expect(client.getQueryState(globalQueries.models("openai").queryKey)?.fetchStatus).toBe(
        "fetching",
      );
      yield* Deferred.succeed(oldRequest, catalog("anthropic", "previous-account", null));
      yield* Effect.yieldNow;
      expect(client.getQueryData(globalQueries.models("anthropic").queryKey)).toEqual({
        ...newCatalog,
        selected: selection,
      });
    }).pipe(Effect.scoped),
);

it.live("keeps account write failures visible and does not select a model", () =>
  Effect.gen(function* () {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const failure = new Error("test account selection failed");
    vi.spyOn(api, "accountAction").mockRejectedValue(failure);
    vi.spyOn(api, "selectModel");
    const mutation = switcher(client);
    yield* uiPromise(() =>
      expect(
        mutation.mutateAsync({
          target: { provider: "anthropic", accountId: "rejected" },
          selectModel: true,
        }),
      ).rejects.toBe(failure),
    );
    expect(api.selectModel).not.toHaveBeenCalled();
    client.clear();
  }),
);
