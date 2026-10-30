import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { Crypto, Effect, HashSet, Option, Ref, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { UrlParams } from "effect/http";
import { JsonValue } from "../../src/json.ts";
import { nativePromise } from "../../src/runtime/native-effect.ts";
import { HttpServerRequest, HttpServerResponse, testHttpServer } from "./http.ts";

/**
 * An HTTP MCP server that wants OAuth, with its authorization server on the same loopback port:
 * protected resource metadata (RFC 9728), dynamic registration, an authorization endpoint that
 * consents at once, and a token endpoint that checks PKCE and the resource, and refreshes.
 */
const decodeMetadata = Schema.decodeUnknownEffect(Schema.Record(Schema.String, JsonValue));

export const fakeOAuthMcpServer = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  /** Access tokens the server accepts. */
  const valid = yield* Ref.make(HashSet.empty<string>());
  const issued = yield* Ref.make(0);
  const refreshes = yield* Ref.make(0);
  /** The PKCE challenge of the code the authorization endpoint gave last. */
  const challenge = yield* Ref.make(Option.none<string>());

  const mcp = createMcpHandler(() => {
    const server = new Server(
      { name: "fake-oauth", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", () => ({
      tools: [
        {
          name: "echo",
          description: "Repeats text.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
    }));
    server.setRequestHandler("tools/call", (request) => ({
      content: [{ type: "text", text: `echo: ${String(request.params.arguments?.text)}` }],
    }));
    return server;
  });

  const issue = Effect.gen(function* () {
    const count = yield* Ref.updateAndGet(issued, (current) => current + 1);
    yield* Ref.update(valid, HashSet.add(`access-${count}`));
    return HttpServerResponse.jsonUnsafe({
      access_token: `access-${count}`,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: `refresh-${count}`,
    });
  });
  const refused = HttpServerResponse.jsonUnsafe({ error: "invalid_grant" }, { status: 400 });

  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url, origin);
    const resource = `${origin}/mcp`;
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/mcp":
        return HttpServerResponse.jsonUnsafe({ resource, authorization_servers: [origin] });
      case "/.well-known/oauth-authorization-server":
        return HttpServerResponse.jsonUnsafe({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
      case "/register": {
        const metadata = yield* Effect.flatMap(request.json, decodeMetadata);
        return HttpServerResponse.jsonUnsafe(
          { ...metadata, client_id: "fake-client" },
          { status: 201 },
        );
      }
      case "/authorize": {
        // The person consents at once; the code is bound to the PKCE challenge.
        yield* Ref.set(challenge, Option.fromNullOr(url.searchParams.get("code_challenge")));
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", "fake-code");
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        back.searchParams.set("iss", origin);
        return url.searchParams.get("resource") === resource
          ? HttpServerResponse.redirect(back, { status: 302 })
          : HttpServerResponse.text("wrong resource", { status: 400 });
      }
      case "/token": {
        const form = yield* request.urlParamsBody;
        const field = (name: string) => Option.getOrUndefined(UrlParams.getFirst(form, name));
        if (field("resource") !== resource) return refused;
        if (field("grant_type") === "refresh_token") {
          yield* Ref.update(refreshes, (count) => count + 1);
          return yield* issue;
        }
        const verified = Base64Url.encode(
          yield* crypto.digest("SHA-256", new TextEncoder().encode(field("code_verifier") ?? "")),
        );
        return field("code") === "fake-code" && Option.contains(yield* Ref.get(challenge), verified)
          ? yield* issue
          : refused;
      }
      case "/mcp": {
        const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        if (!HashSet.has(yield* Ref.get(valid), token))
          return HttpServerResponse.text("unauthorized", {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        const web = yield* HttpServerRequest.toWeb(request);
        return HttpServerResponse.fromWeb(yield* nativePromise(() => mcp.fetch(web)));
      }
      default:
        return HttpServerResponse.text("not found", { status: 404 });
    }
  });

  const { url } = yield* testHttpServer(handler);
  return {
    url: `${url}/mcp`,
    /** The server stops accepting the access tokens it gave, as when they expire. */
    expireTokens: Ref.set(valid, HashSet.empty<string>()),
    refreshes: Ref.get(refreshes),
  };
});
