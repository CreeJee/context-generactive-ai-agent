import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vite-plus/test";
import type { JsonValue } from "../json.ts";
import {
  McpClientAuthentication,
  McpOAuthClient,
  McpOAuthConfig,
  McpServerConfig,
  readMcpFile,
} from "./config.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const url = "https://example.com/mcp";
const issuer = "https://auth.example.com";

/** An `.mcp.json` with one http server whose `oauth` is `oauth`, as the app reads it. */
const withOAuth = (oauth: { readonly [key: string]: JsonValue }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${yield* fs.makeTempDirectoryScoped()}/.mcp.json`;
    yield* fs.writeFileString(
      file,
      yield* encodeJson({ mcpServers: { docs: { type: "http", url, oauth } } }),
    );
    return yield* readMcpFile(file, "project");
  }).pipe(Effect.scoped);

layer(NodeFileSystem.layer)("MCP server OAuth settings", (it) => {
  it.effect("an http server's oauth is read as the grant and client it describes", () =>
    Effect.gen(function* () {
      const person = yield* withOAuth({
        clientId: "app",
        issuer,
        clientSecret: "${APP_SECRET}",
        callbackPort: 33418,
      });
      expect(person.servers[0]?.config).toEqual(
        McpServerConfig.cases.http.make({
          url,
          headers: {},
          oauth: McpOAuthConfig.cases.authorizationCode.make({
            client: McpOAuthClient.cases.registered.make({
              clientId: "app",
              issuer,
              authentication: McpClientAuthentication.cases.secret.make({
                secret: "${APP_SECRET}",
              }),
            }),
            callbackPort: 33418,
          }),
        }),
      );
      const machine = yield* withOAuth({
        grant: "client_credentials",
        clientId: "bot",
        issuer,
        privateKey: { key: "${BOT_KEY}", algorithm: "RS256" },
      });
      expect(machine.servers[0]?.config).toEqual(
        McpServerConfig.cases.http.make({
          url,
          headers: {},
          oauth: McpOAuthConfig.cases.clientCredentials.make({
            clientId: "bot",
            issuer,
            authentication: McpClientAuthentication.cases.privateKeyJwt.make({
              privateKey: "${BOT_KEY}",
              algorithm: "RS256",
            }),
          }),
        }),
      );
    }),
  );

  it.effect("oauth settings that cannot work together make the file invalid", () =>
    Effect.gen(function* () {
      const read = yield* Effect.forEach(
        [
          // One way to prove the client, not two.
          {
            clientId: "app",
            issuer,
            clientSecret: "${A}",
            privateKey: { key: "${B}", algorithm: "RS256" },
          },
          // The app as itself needs its client and the issuer that knows it.
          { grant: "client_credentials", clientId: "bot" },
          { clientSecret: "${A}" },
          // A metadata URL is the client id.
          { clientId: "app", clientMetadataUrl: "https://app.example.com/client.json" },
          // A secret is only ever a reference to the environment.
          { clientId: "app", issuer, clientSecret: "plain-secret" },
        ],
        withOAuth,
      );
      expect(read.map((file) => file.error?.code)).toEqual(Array(5).fill("invalid_config"));
    }),
  );
});
