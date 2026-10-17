import { Effect, Schema } from "effect";
import {
  CompatibleConnectionInput,
  CompatibleModelInput,
  OpenAICompatibleStatus,
} from "memory-agent/compatible-config";
import { appFetch } from "../shared/backend-restart";
import { appQueryKeys } from "../queries/keys";

export type {
  CompatibleAccountStatus,
  CompatibleConnectionInput,
  CompatibleModelInput,
} from "memory-agent/compatible-config";

const provider = { provider: Schema.Literal("openai-compatible") };
const CompatibleAction = Schema.Union([
  Schema.Struct({
    ...provider,
    intent: Schema.Literal("create"),
    label: Schema.optional(Schema.String),
    ...CompatibleConnectionInput.fields,
  }),
  Schema.Struct({
    ...provider,
    intent: Schema.Literal("connect"),
    accountId: Schema.String,
    ...CompatibleConnectionInput.fields,
  }),
  Schema.Struct({
    ...provider,
    intent: Schema.Literal("rename"),
    accountId: Schema.String,
    label: Schema.String,
  }),
  Schema.Struct({
    ...provider,
    intent: Schema.Literal("save-model"),
    accountId: Schema.String,
    model: CompatibleModelInput,
  }),
  Schema.Struct({
    ...provider,
    intent: Schema.Literals(["remove-model", "test"]),
    accountId: Schema.String,
    modelId: Schema.String,
  }),
  Schema.Struct({
    ...provider,
    intent: Schema.Literals(["select", "remove", "discover"]),
    accountId: Schema.String,
  }),
]);
type CompatibleAction = typeof CompatibleAction.Type;
export const CompatibleAccountsView = Schema.Struct({
  type: Schema.Literal("compatible-endpoint"),
  ...OpenAICompatibleStatus.fields,
});
export type CompatibleAccountsView = typeof CompatibleAccountsView.Type;
const TestResult = Schema.Struct({ ok: Schema.Literal(true) });
const ModelList = Schema.Struct({ models: Schema.Array(Schema.Struct({ id: Schema.String })) });

export class CompatibleRequestFailed extends Schema.TaggedError<CompatibleRequestFailed>()(
  "CompatibleRequestFailed",
  {
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
    reason: Schema.Union([
      Schema.TaggedStruct("TransportFailed", {}),
      Schema.TaggedStruct("PartialWrite", {}),
      Schema.TaggedStruct("RequestRejected", {}),
      Schema.TaggedStruct("InvalidResponse", {}),
    ]),
    message: Schema.String,
  },
) {}

type WithoutProvider<T> = T extends unknown ? Omit<T, "provider"> : never;
/** A compatible-endpoint command that changes accounts; each answers with the complete list. */
export type CompatibleAccountChange = WithoutProvider<
  Exclude<CompatibleAction, { readonly intent: "test" | "discover" }>
>;

export function makeCompatibleClient(fetcher: typeof fetch) {
  const requestEffect = <A, I>(schema: Schema.Codec<A, I>, body?: CompatibleAction) =>
    Effect.gen(function* () {
      const operation = body?.intent ?? "list";
      const failed = (reason: CompatibleRequestFailed["reason"]["_tag"], status: number) =>
        CompatibleRequestFailed.make({
          operation,
          status,
          reason: { _tag: reason },
          message:
            reason === "PartialWrite"
              ? "키와 설정이 부분적으로 저장됐을 수 있어요. 계정 목록을 새로고침하고 키 상태를 확인해 주세요."
              : `호환 공급자 요청에 실패했어요 (${status}).`,
        });
      const signal = yield* Effect.abortSignal;
      const encoded =
        body === undefined
          ? undefined
          : yield* Schema.encodeEffect(Schema.fromJsonString(CompatibleAction))(body).pipe(
              Effect.mapError(() => failed("InvalidResponse", 0)),
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
        catch: () => failed("TransportFailed", 0),
      });
      if (response.status === 409) return yield* failed("PartialWrite", response.status);
      if (!response.ok) return yield* failed("RequestRejected", response.status);
      const json: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => failed("InvalidResponse", response.status),
      });
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => failed("InvalidResponse", response.status)),
      );
    }).pipe(Effect.scoped);
  const effects = {
    list: () => requestEffect(CompatibleAccountsView),
    change: (change: CompatibleAccountChange) =>
      requestEffect(CompatibleAccountsView, { provider: "openai-compatible", ...change }),
    test: (accountId: string, modelId: string) =>
      requestEffect(TestResult, {
        provider: "openai-compatible",
        intent: "test",
        accountId,
        modelId,
      }),
    discover: (accountId: string) =>
      requestEffect(ModelList, { provider: "openai-compatible", intent: "discover", accountId }),
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
