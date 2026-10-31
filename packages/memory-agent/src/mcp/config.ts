import { isHttpsUrl } from "@modelcontextprotocol/client";
import { Function as EffectFunction } from "effect";
import { SchemaIssue, SchemaTransformation } from "effect";
import { optionalProperty } from "../optional-property.ts";
import { sha256 as hashSha256 } from "../runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { join } = platformPath;
import { Array as Arr, Effect, FileSystem, Option, Result, Schema } from "effect";
import type { ConfigFileFailureCode, ShownFailure } from "../runtime/shown-failure.ts";
import type { McpScope } from "./contracts.ts";

export const globalMcpFile = (storageRoot: string) => join(storageRoot, "mcp.json");
/** The same file name Claude Code and other agents read, so a project's servers are shared. */
export const projectMcpFile = (projectRoot: string) => join(projectRoot, ".mcp.json");

/** A `${NAME}` reference: client secrets and keys come from the environment, never the file. */
const VariableReference = Schema.String.check(Schema.isPattern(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/));

/** How a client registered beforehand proves itself at the token endpoint. */
export const McpClientAuthentication = Schema.TaggedUnion({
  /** `client_secret_basic` or `client_secret_post`, whichever the authorization server takes. */
  secret: { secret: VariableReference },
  /** `private_key_jwt` (RFC 7523): a PKCS#8 PEM or JWK the client signs an assertion with. */
  privateKeyJwt: { privateKey: VariableReference, algorithm: Schema.NonEmptyString },
});
export type McpClientAuthentication = typeof McpClientAuthentication.Type;

/** A Client ID Metadata Document URL (SEP-991): https with a path. */
const MetadataUrl = Schema.String.check(
  Schema.makeFilter((url) => isHttpsUrl(url) || "an https URL with a path"),
);

export const McpOAuthClient = Schema.TaggedUnion({
  /**
   * Registers itself at the first login: as its metadata document URL when the authorization
   * server takes one, otherwise by Dynamic Client Registration (RFC 7591).
   */
  automatic: { metadataUrl: Schema.optionalKey(MetadataUrl) },
  /** Registered with the authorization server beforehand. */
  registered: {
    clientId: Schema.NonEmptyString,
    /** The authorization server the client belongs to; its credentials are sent nowhere else. */
    issuer: Schema.optionalKey(Schema.NonEmptyString),
    authentication: Schema.optionalKey(McpClientAuthentication),
  },
});
export type McpOAuthClient = typeof McpOAuthClient.Type;

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

/** How the app gets an access token for an HTTP server that asks for one (MCP authorization). */
export const McpOAuthConfig = Schema.TaggedUnion({
  /** A person logs in in the browser (authorization code with PKCE). */
  authorizationCode: {
    client: McpOAuthClient,
    /** The loopback port the login listens on; a client registered beforehand needs its own. */
    callbackPort: Schema.optionalKey(Port),
    scope: Schema.optionalKey(Schema.NonEmptyString),
  },
  /** The app authenticates as itself, without a person (client credentials). */
  clientCredentials: {
    clientId: Schema.NonEmptyString,
    issuer: Schema.NonEmptyString,
    authentication: McpClientAuthentication,
    scope: Schema.optionalKey(Schema.NonEmptyString),
  },
});
export type McpOAuthConfig = typeof McpOAuthConfig.Type;
const AuthorizationCode = McpOAuthConfig.cases.authorizationCode;
const ClientCredentials = McpOAuthConfig.cases.clientCredentials;

export const McpServerConfig = Schema.TaggedUnion({
  /** A server the app starts itself and talks to over stdin/stdout. */
  stdio: {
    command: Schema.NonEmptyString,
    args: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
  },
  /**
   * A server already running somewhere, reached over Streamable HTTP. Without `oauth`, a server
   * that asks for authorization gets a login with a client that registers itself.
   */
  http: {
    url: Schema.NonEmptyString,
    headers: Schema.Record(Schema.String, Schema.String),
    oauth: Schema.optionalKey(McpOAuthConfig),
  },
});
export type McpServerConfig = typeof McpServerConfig.Type;
const StdioServer = McpServerConfig.cases.stdio;
const HttpServer = McpServerConfig.cases.http;

const StringMap = Schema.Record(Schema.String, Schema.String);

/** The `oauth` object of an http entry, as written: every key optional, checked when decoded. */
const OAuthEntry = Schema.Struct({
  grant: Schema.optionalKey(Schema.Literals(["authorization_code", "client_credentials"])),
  clientId: Schema.optionalKey(Schema.NonEmptyString),
  clientSecret: Schema.optionalKey(VariableReference),
  privateKey: Schema.optionalKey(
    Schema.Struct({ key: VariableReference, algorithm: Schema.NonEmptyString }),
  ),
  clientMetadataUrl: Schema.optionalKey(MetadataUrl),
  issuer: Schema.optionalKey(Schema.NonEmptyString),
  callbackPort: Schema.optionalKey(Port),
  scope: Schema.optionalKey(Schema.NonEmptyString),
});
type OAuthEntry = typeof OAuthEntry.Type;

const invalidOAuth = (message: string) => Effect.fail(new SchemaIssue.InvalidValue({ message }));

type DecodedOAuth<A> = Effect.Effect<A, SchemaIssue.Issue>;

const authenticationOf = (
  entry: OAuthEntry,
): DecodedOAuth<Option.Option<McpClientAuthentication>> =>
  entry.clientSecret !== undefined && entry.privateKey !== undefined
    ? invalidOAuth("clientSecret and privateKey cannot both be set")
    : Effect.succeed(
        entry.clientSecret !== undefined
          ? Option.some(McpClientAuthentication.cases.secret.make({ secret: entry.clientSecret }))
          : Option.map(Option.fromUndefinedOr(entry.privateKey), ({ key, algorithm }) =>
              McpClientAuthentication.cases.privateKeyJwt.make({ privateKey: key, algorithm }),
            ),
      );

const clientCredentialsOf = (
  entry: OAuthEntry,
  authentication: Option.Option<McpClientAuthentication>,
): DecodedOAuth<McpOAuthConfig> =>
  entry.clientId === undefined || entry.issuer === undefined || Option.isNone(authentication)
    ? invalidOAuth("client_credentials needs clientId, issuer, and clientSecret or privateKey")
    : entry.callbackPort !== undefined || entry.clientMetadataUrl !== undefined
      ? invalidOAuth("client_credentials takes no callbackPort or clientMetadataUrl")
      : Effect.succeed(
          ClientCredentials.make({
            clientId: entry.clientId,
            issuer: entry.issuer,
            authentication: authentication.value,
            ...optionalProperty("scope", entry.scope),
          }),
        );

const authorizationCodeOf = (
  entry: OAuthEntry,
  authentication: Option.Option<McpClientAuthentication>,
): DecodedOAuth<McpOAuthConfig> =>
  entry.clientId === undefined
    ? Option.isSome(authentication) || entry.issuer !== undefined
      ? invalidOAuth("clientSecret, privateKey and issuer need clientId")
      : Effect.succeed(
          AuthorizationCode.make({
            client: McpOAuthClient.cases.automatic.make(
              optionalProperty("metadataUrl", entry.clientMetadataUrl),
            ),
            ...optionalProperty("callbackPort", entry.callbackPort),
            ...optionalProperty("scope", entry.scope),
          }),
        )
    : entry.clientMetadataUrl !== undefined
      ? invalidOAuth("clientMetadataUrl is the client id, so it cannot go with clientId")
      : Option.isSome(authentication) && entry.issuer === undefined
        ? invalidOAuth("a clientSecret or privateKey needs the issuer it belongs to")
        : Effect.succeed(
            AuthorizationCode.make({
              client: McpOAuthClient.cases.registered.make({
                clientId: entry.clientId,
                ...optionalProperty("issuer", entry.issuer),
                ...optionalProperty("authentication", Option.getOrUndefined(authentication)),
              }),
              ...optionalProperty("callbackPort", entry.callbackPort),
              ...optionalProperty("scope", entry.scope),
            }),
          );

const authenticationEntry = (
  authentication: McpClientAuthentication | undefined,
): Pick<OAuthEntry, "clientSecret" | "privateKey"> =>
  authentication === undefined
    ? {}
    : McpClientAuthentication.match<Pick<OAuthEntry, "clientSecret" | "privateKey">>(
        authentication,
        {
          secret: ({ secret }) => ({ clientSecret: secret }),
          privateKeyJwt: ({ privateKey, algorithm }) => ({
            privateKey: { key: privateKey, algorithm },
          }),
        },
      );

const oauthEntryOf = McpOAuthConfig.match<OAuthEntry>({
  authorizationCode: (config) => ({
    ...McpOAuthClient.match<OAuthEntry>(config.client, {
      automatic: (client) => optionalProperty("clientMetadataUrl", client.metadataUrl),
      registered: (client) => ({
        clientId: client.clientId,
        ...optionalProperty("issuer", client.issuer),
        ...authenticationEntry(client.authentication),
      }),
    }),
    ...optionalProperty("callbackPort", config.callbackPort),
    ...optionalProperty("scope", config.scope),
  }),
  clientCredentials: (config) => ({
    grant: "client_credentials",
    clientId: config.clientId,
    issuer: config.issuer,
    ...authenticationEntry(config.authentication),
    ...optionalProperty("scope", config.scope),
  }),
});

const OAuthFileEntry = OAuthEntry.pipe(
  Schema.decodeTo(
    McpOAuthConfig,
    SchemaTransformation.transformEffect({
      decode: (entry) =>
        Effect.flatMap(authenticationOf(entry), (authentication) =>
          entry.grant === "client_credentials"
            ? clientCredentialsOf(entry, authentication)
            : authorizationCodeOf(entry, authentication),
        ),
      encode: (config) => Effect.succeed(oauthEntryOf(config)),
    }),
  ),
);

/**
 * `.mcp.json` entries: `{ command, args?, env? }` (type absent or "stdio") or
 * `{ type: "http", url, headers?, oauth? }`.
 */
const FileEntry = Schema.Union([
  Schema.Struct({
    type: Schema.optional(Schema.Literal("stdio")),
    command: Schema.NonEmptyString,
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(StringMap),
  }).pipe(
    Schema.decodeTo(
      StdioServer,
      SchemaTransformation.transform({
        decode: (entry) =>
          StdioServer.make({
            command: entry.command,
            args: entry.args ?? [],
            env: entry.env ?? {},
          }),
        encode: (server) => ({ command: server.command, args: server.args, env: server.env }),
      }),
    ),
  ),
  Schema.Struct({
    type: Schema.Literal("http"),
    url: Schema.NonEmptyString,
    headers: Schema.optional(StringMap),
    oauth: Schema.optionalKey(OAuthFileEntry),
  }).pipe(
    Schema.decodeTo(
      HttpServer,
      SchemaTransformation.transform({
        decode: (entry) =>
          HttpServer.make({
            url: entry.url,
            headers: entry.headers ?? {},
            ...optionalProperty("oauth", entry.oauth),
          }),
        encode: (server) => ({
          type: "http" as const,
          url: server.url,
          headers: server.headers,
          ...optionalProperty("oauth", server.oauth),
        }),
      }),
    ),
  ),
]);

/** Server names become part of tool names, so they are kept short and plain. */
export const McpServerName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,32}$/)),
);
const isServerName = Schema.is(McpServerName);

const McpFile = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, FileEntry),
});
const decodeMcpFile = Schema.decodeUnknownResult(Schema.fromJsonString(McpFile));

export interface ConfiguredServer {
  readonly scope: McpScope;
  readonly name: string;
  readonly config: McpServerConfig;
  /** Hash of the exact configuration. Trust is given to this, not to the name. */
  readonly fingerprint: string;
}

export interface McpFileRead {
  readonly path: string;
  readonly servers: readonly ConfiguredServer[];
  /** Why the file could not be used. A missing file is not an error. */
  /** Not redacted: the owner hides secrets in `detail` before showing it. */
  readonly error: ShownFailure<ConfigFileFailureCode> | null;
}

export const fingerprintOf = (config: McpServerConfig) =>
  hashSha256(
    JSON.stringify(
      EffectFunction.flow(Schema.encodeResult(McpServerConfig), Result.getOrThrow)(config),
    ),
  );

const readMcpFileBody = Effect.fn("mcp.readConfig")(function* (path: string, scope: McpScope) {
  const fs = yield* FileSystem.FileSystem;
  // A file whose presence cannot be checked is treated as absent, like a missing one.
  if (!(yield* fs.exists(path).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)))))
    return { path, servers: [], error: null } satisfies McpFileRead;
  return yield* fs.readFileString(path).pipe(
    Effect.match({
      onFailure: (): McpFileRead => ({
        path,
        servers: [],
        error: { code: "unreadable", detail: null },
      }),
      onSuccess: (text): McpFileRead =>
        Result.match(decodeMcpFile(text), {
          onFailure: (error) => ({
            path,
            servers: [],
            error: {
              code: "invalid_config" as const,
              detail: String(error).split("\n").slice(0, 4).join("\n"),
            },
          }),
          onSuccess: (file) => {
            const entries = Object.entries(file.mcpServers);
            const invalid = entries.filter(([name]) => !isServerName(name)).map(([name]) => name);
            return {
              path,
              // The valid servers stay usable; the others are named so the user can rename them.
              error:
                invalid.length > 0
                  ? { code: "invalid_names" as const, detail: invalid.join(", ") }
                  : null,
              servers: entries
                .filter(([name]) => isServerName(name))
                .map(([name, config]) => ({
                  scope,
                  name,
                  config,
                  fingerprint: fingerprintOf(config),
                })),
            };
          },
        }),
    }),
  );
});

export const readMcpFile: {
  (scope: McpScope): (path: string) => ReturnType<typeof readMcpFileBody>;
} & typeof readMcpFileBody = EffectFunction.dual(2, readMcpFileBody);

/** A `${NAME}` the configuration uses is not set; the message names the variable, not a value. */
export class MissingVariable extends Schema.TaggedError<
  MissingVariable,
  { readonly brand: unique symbol }
>()("MissingVariable", {
  variable: Schema.String,
}) {
  override get message() {
    return `missing_env: ${this.variable}`;
  }
}

const variablePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replaces `${NAME}` with the app's environment, so secrets can stay out of the file. */
export const expandVariablesResult: {
  (env: NodeJS.ProcessEnv): (value: string) => Result.Result<string, MissingVariable>;
} & typeof expandVariablesResultBody = EffectFunction.dual(2, expandVariablesResultBody);
function expandVariablesResultBody(
  value: string,
  env: NodeJS.ProcessEnv,
): Result.Result<string, MissingVariable> {
  const missing = Arr.findFirst(Array.from(value.matchAll(variablePattern)), ([, name]) =>
    Option.filter(Option.fromUndefinedOr(name), (variable) => env[variable] === undefined),
  );
  return Option.match(missing, {
    onSome: (variable) => Result.fail(MissingVariable.make({ variable })),
    onNone: () =>
      Result.succeed(value.replace(variablePattern, (_, name: string) => env[name] ?? "")),
  });
}

/** `expandVariablesResult` for synchronous SDK transport builders, which throw the typed error. */
export const expandVariables: {
  (env: NodeJS.ProcessEnv): (value: string) => ReturnType<typeof expandVariablesBody>;
} & typeof expandVariablesBody = EffectFunction.dual(2, expandVariablesBody);
function expandVariablesBody(value: string, env: NodeJS.ProcessEnv): string {
  return Result.getOrThrow(expandVariablesResult(value, env));
}
