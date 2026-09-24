import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { SecretStore, type SecretStoreFailed } from "../config/secrets.ts";

/** The server the Kagi TypeScript SDK targets (`servers.ts`). */
export const kagiBaseUrl = "https://kagi.com/api/v1";

/** Extract takes at most this many URLs per request (Kagi API docs). */
export const maxExtractUrls = 10;

/** Whether Kagi can be used, as the settings page shows it. The key itself is never returned. */
export interface KagiStatus {
  readonly keyRegistered: boolean;
  readonly enabled: boolean;
}

export class KagiKeyMissing extends Data.TaggedError("KagiKeyMissing")<{}> {}

/**
 * Why a Kagi request did not produce a result. No request is retried: the model gets the reason
 * and decides whether to call again (R19).
 */
export type KagiFailureReason =
  | "not_enabled"
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "unavailable"
  | "invalid_response";

const failureMessages: Record<KagiFailureReason, string> = {
  not_enabled: "Kagi is turned off or has no API key. The user has to enable it in settings.",
  invalid_request: "Kagi rejected the request parameters (400).",
  unauthorized: "Kagi rejected the API key (401). The user has to register a valid key.",
  forbidden: "Kagi refused this client (403), for example because of an IP restriction.",
  rate_limited: "Kagi rate limit or usage limit reached (429).",
  server_error: "Kagi failed on its side.",
  unavailable: "Kagi could not be reached.",
  invalid_response: "Kagi answered with a body that does not match its API schema.",
};

export class KagiFailed extends Data.TaggedError("KagiFailed")<{
  readonly reason: KagiFailureReason;
  readonly status: number | null;
}> {
  override get message() {
    return `kagi_${this.reason}: ${failureMessages[this.reason]}`;
  }
}

const failureForStatus = (status: number): KagiFailed => {
  switch (status) {
    case 400:
      return new KagiFailed({ reason: "invalid_request", status });
    case 401:
      return new KagiFailed({ reason: "unauthorized", status });
    case 403:
      return new KagiFailed({ reason: "forbidden", status });
    case 429:
      return new KagiFailed({ reason: "rate_limited", status });
    default:
      return new KagiFailed({
        reason: status >= 500 ? "server_error" : "invalid_response",
        status,
      });
  }
};

// Response models of the SDK (`models/*.ts`), only the fields the tools pass on.
const SearchResult = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  snippet: Schema.optional(Schema.NullOr(Schema.String)),
  time: Schema.optional(Schema.NullOr(Schema.String)),
});
export type KagiSearchResult = typeof SearchResult.Type;

const SearchResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      search: Schema.optional(Schema.Array(SearchResult)),
      news: Schema.optional(Schema.Array(SearchResult)),
      directAnswer: Schema.optional(Schema.Array(SearchResult)),
    }),
  ),
});

const ErrorDetail = Schema.Struct({
  code: Schema.String,
  url: Schema.String,
  message: Schema.optional(Schema.NullOr(Schema.String)),
});

const ExtractResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      markdown: Schema.optional(Schema.NullOr(Schema.String)),
      error: Schema.optional(Schema.String),
    }),
  ),
  errors: Schema.optional(Schema.Array(ErrorDetail)),
});
export type KagiExtractResponse = typeof ExtractResponse.Type;

export interface KagiSearchInput {
  readonly query: string;
  readonly limit: number;
}

/** Request bodies of the two endpoints (SDK `SearchRequest`, `ExtractRequest`). */
type KagiRequestBody =
  | { readonly query: string; readonly limit: number }
  | { readonly pages: ReadonlyArray<{ readonly url: string }>; readonly format: "markdown" };

export interface KagiOptions {
  /** Tests point this at a local server. */
  readonly baseUrl?: string;
}

const make = (options: KagiOptions) =>
  Effect.gen(function* () {
    const config = yield* GlobalConfig;
    const secrets = yield* SecretStore;
    const baseUrl = options.baseUrl ?? kagiBaseUrl;

    const status: Effect.Effect<KagiStatus, SecretStoreFailed> = Effect.gen(function* () {
      const key = yield* secrets.get("kagi-api-key");
      const settings = yield* config.read;
      return {
        keyRegistered: key !== null,
        enabled: key !== null && settings.kagiEnabled === true,
      };
    });

    /** One POST. The key is read right before it, so a removed key stops the very next call. */
    const post = <A, I>(
      path: string,
      body: KagiRequestBody,
      schema: Schema.Codec<A, I>,
      signal?: AbortSignal,
    ) =>
      Effect.gen(function* () {
        const settings = yield* config.read;
        const key = yield* Effect.orElseSucceed(secrets.get("kagi-api-key"), () => null);
        if (!settings.kagiEnabled || key === null)
          return yield* new KagiFailed({ reason: "not_enabled", status: null });
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${baseUrl}${path}`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify(body),
              // A redirect could carry the key to another host.
              redirect: "error",
              signal,
            }),
          // The transport error can quote the request, so only the reason is kept.
          catch: () => new KagiFailed({ reason: "unavailable", status: null }),
        });
        if (!response.ok) return yield* failureForStatus(response.status);
        const json = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () => new KagiFailed({ reason: "invalid_response", status: response.status }),
        });
        return yield* Option.match(Schema.decodeUnknownOption(schema)(json), {
          onNone: () => Effect.fail(new KagiFailed({ reason: "invalid_response", status: 200 })),
          onSome: Effect.succeed,
        });
      });

    return {
      status,

      /** Stores the key in the keychain. Registering does not turn Kagi on. */
      registerKey: (key: string) => secrets.set("kagi-api-key", key.trim()),

      /** Removes the key and turns Kagi off, so no further request can be made. */
      removeKey: Effect.gen(function* () {
        yield* config.update({ kagiEnabled: false });
        yield* secrets.remove("kagi-api-key");
      }),

      setEnabled: (enabled: boolean) =>
        Effect.gen(function* () {
          if (enabled && (yield* secrets.get("kagi-api-key")) === null)
            return yield* new KagiKeyMissing();
          yield* config.update({ kagiEnabled: enabled });
          return yield* status;
        }),

      /** POST /search (SDK `SearchApi.search`). */
      search: (input: KagiSearchInput, signal?: AbortSignal) =>
        post("/search", { query: input.query, limit: input.limit }, SearchResponse, signal),

      /** POST /extract (SDK `ExtractApi.extractContent`), Markdown per page. */
      extract: (urls: readonly string[], signal?: AbortSignal) =>
        post(
          "/extract",
          { pages: urls.map((url) => ({ url })), format: "markdown" },
          ExtractResponse,
          signal,
        ),
    };
  });

/** Optional Kagi Search and Extract (R19): off until the user registers a key and turns it on. */
export class Kagi extends Context.Service<Kagi, Effect.Success<ReturnType<typeof make>>>()(
  "memory-agent/Kagi",
) {
  static readonly layer = (options: KagiOptions = {}) => Layer.effect(Kagi, make(options));
}
