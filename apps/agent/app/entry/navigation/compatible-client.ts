import { Effect, Schema } from "effect";
import {
  CompatibleAccountCommand,
  CompatibleModelList,
  CompatibleTestResult,
} from "memory-agent/app-api";
import { CompatibleAccountsView } from "memory-agent/compatible-config";
import { appFetch } from "../shared/backend-restart";
import { problemText } from "../shared/copy-templates";
import { appQueryKeys } from "../queries/keys";
import { navigationCopy } from "./copy";

export type {
  CompatibleAccountStatus,
  CompatibleConnectionInput,
  CompatibleModelInput,
} from "memory-agent/compatible-config";

export { CompatibleAccountsView };

/** Why a compatible-endpoint request failed; the rejected body is never read. */
export const CompatibleRequestFailedReason = Schema.TaggedUnion({
  TransportFailed: {},
  PartialWrite: {},
  RequestRejected: {},
  InvalidResponse: {},
});
export type CompatibleRequestFailedReason = typeof CompatibleRequestFailedReason.Type;
const reasons = CompatibleRequestFailedReason.cases;

export class CompatibleRequestFailed extends Schema.TaggedError<
  CompatibleRequestFailed,
  { readonly brand: unique symbol }
>()("CompatibleRequestFailed", {
  operation: Schema.Literals([
    "list",
    "create",
    "connect",
    "rename",
    "save-model",
    "remove-model",
    "select",
    "remove",
    "test",
    "discover",
  ]),
  status: Schema.Finite,
  reason: CompatibleRequestFailedReason,
  message: Schema.String,
}) {}

type WithoutProvider<T> = T extends unknown ? Omit<T, "provider"> : never;
/** A compatible-endpoint command that changes accounts; each answers with the complete list. */
export type CompatibleAccountChange = WithoutProvider<
  Exclude<CompatibleAccountCommand, { readonly intent: "test" | "discover" }>
>;

export function makeCompatibleClient(fetcher: typeof fetch) {
  const requestEffect = <A, I>(schema: Schema.Codec<A, I>, body?: CompatibleAccountCommand) =>
    Effect.gen(function* () {
      const operation = body?.intent ?? "list";
      const failed = (reason: CompatibleRequestFailedReason, status: number) =>
        CompatibleRequestFailed.make({
          operation,
          status,
          reason,
          message: CompatibleRequestFailedReason.guards.PartialWrite(reason)
            ? problemText(navigationCopy.compatible.partialWrite)
            : navigationCopy.compatible.requestFailedWith(status),
        });
      const signal = yield* Effect.abortSignal;
      const encoded =
        body === undefined
          ? undefined
          : yield* Schema.encodeEffect(Schema.fromJsonString(CompatibleAccountCommand))(body).pipe(
              Effect.mapError(() => failed(reasons.InvalidResponse.make({}), 0)),
            );
      const response = yield* Effect.tryPromise({
        try: () =>
          fetcher(
            encoded === undefined ? "/api/accounts?provider=openai-compatible" : "/api/accounts",
            encoded === undefined
              ? { signal }
              : {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: encoded,
                  signal,
                },
          ),
        catch: () => failed(reasons.TransportFailed.make({}), 0),
      });
      if (response.status === 409)
        return yield* failed(reasons.PartialWrite.make({}), response.status);
      if (!response.ok) return yield* failed(reasons.RequestRejected.make({}), response.status);
      const json: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => failed(reasons.InvalidResponse.make({}), response.status),
      });
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => failed(reasons.InvalidResponse.make({}), response.status)),
      );
    }).pipe(Effect.scoped);
  const effects = {
    list: () => requestEffect(CompatibleAccountsView),
    change: (change: CompatibleAccountChange) =>
      requestEffect(CompatibleAccountsView, { provider: "openai-compatible", ...change }),
    test: (accountId: string, modelId: string) =>
      requestEffect(CompatibleTestResult, {
        provider: "openai-compatible",
        intent: "test",
        accountId,
        modelId,
      }),
    discover: (accountId: string) =>
      requestEffect(CompatibleModelList, {
        provider: "openai-compatible",
        intent: "discover",
        accountId,
      }),
  };
  return {
    effects,
    list: () => Effect.runPromise(effects.list()),
    change: (change: CompatibleAccountChange) => Effect.runPromise(effects.change(change)),
    test: (accountId: string, modelId: string) =>
      Effect.runPromise(effects.test(accountId, modelId)),
    discover: (accountId: string) => Effect.runPromise(effects.discover(accountId)),
  };
}
export const compatibleClient = makeCompatibleClient(appFetch);
export const compatibleQueryKey = appQueryKeys.global.accounts("openai-compatible");
