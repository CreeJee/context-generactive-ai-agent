import { Effect, Schema } from "effect";
import { OpenAICompatibleStatus, OpenAICompatibleUpdate } from "memory-agent/compatible-config";
import { appFetch } from "../shared/backend-restart";

import type { OpenAICompatibleUpdate as CompatibleUpdate } from "memory-agent/compatible-config";
export type {
  OpenAICompatibleConfiguration as CompatibleConfiguration,
  OpenAICompatibleStatus as CompatibleStatus,
  OpenAICompatibleUpdate as CompatibleUpdate,
} from "memory-agent/compatible-config";

const CompatibleCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("update"), ...OpenAICompatibleUpdate.fields }),
  Schema.Struct({ action: Schema.Literal("test") }),
  Schema.Struct({ action: Schema.Literal("list") }),
]);
type CompatibleCommand = typeof CompatibleCommand.Type;
const TestResult = Schema.Struct({ ok: Schema.Literal(true) });
const ModelList = Schema.Struct({ models: Schema.Array(Schema.Struct({ id: Schema.String })) });

export class CompatibleRequestFailed extends Schema.TaggedError<CompatibleRequestFailed>()(
  "CompatibleRequestFailed",
  {
    operation: Schema.Literals(["status", "update", "test", "list"]),
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

export function makeCompatibleClient(fetcher: typeof appFetch) {
  const requestEffect = <A, I>(schema: Schema.Codec<A, I>, body?: CompatibleCommand) =>
    Effect.gen(function* () {
      const operation = body?.action ?? "status";
      const failed = (reason: CompatibleRequestFailed["reason"]["_tag"], status: number) =>
        CompatibleRequestFailed.make({
          operation,
          status,
          reason: { _tag: reason },
          message:
            reason === "PartialWrite"
              ? "키와 설정이 부분적으로 저장됐을 수 있어요. 설정을 새로고침하고 키 상태를 확인해 주세요."
              : `호환 공급자 요청에 실패했어요 (${status}).`,
        });
      const signal = yield* Effect.abortSignal;
      const encoded =
        body === undefined
          ? undefined
          : yield* Schema.encodeEffect(Schema.fromJsonString(CompatibleCommand))(body).pipe(
              Effect.mapError(() => failed("InvalidResponse", 0)),
            );
      const response = yield* Effect.tryPromise({
        try: () =>
          fetcher(
            "/api/settings/compatible",
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
    status: () => requestEffect(OpenAICompatibleStatus),
    update: (configuration: CompatibleUpdate) =>
      requestEffect(OpenAICompatibleStatus, { action: "update", ...configuration }),
    test: () => requestEffect(TestResult, { action: "test" }),
    list: () => requestEffect(ModelList, { action: "list" }),
  };
  return {
    effects,
    status: () => Effect.runPromise(effects.status()),
    update: (configuration: CompatibleUpdate) => Effect.runPromise(effects.update(configuration)),
    test: () => Effect.runPromise(effects.test()),
    list: () => Effect.runPromise(effects.list()),
  };
}
export const compatibleClient = makeCompatibleClient(appFetch);
export const compatibleQueryKey = ["settings", "openai-compatible"] as const;
