#!/usr/bin/env node
// ACP agent for editors (Zed and others): speaks ACP on stdin/stdout and works through the running
// context-generactive-agent app. Set CONTEXT_AGENT_URL when the app is not on the default address.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Readable, Writable } from "node:stream";
import { Config, Effect } from "effect";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createAppApi, defaultAppUrl, startAcpAgent } from "../src/acp/index.ts";

// Native host/SDK configuration boundary reads or forwards the host environment.
const baseUrl = await Effect.runPromise(
  Config.String("CONTEXT_AGENT_URL").pipe(
    Config.withDefault(defaultAppUrl),
    Effect.map((url) => url.replace(/\/+$/, "")),
  ),
);
const api = createAppApi(baseUrl);
const connection = startAcpAgent({
  api,
  stream: ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
});
await connection.closed;
