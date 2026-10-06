#!/usr/bin/env node
// ACP agent for editors (Zed and others): speaks ACP on stdin/stdout and works through the running
// context-generactive-agent app. Set CONTEXT_AGENT_URL when the app is not on the default address.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createAppApi, defaultAppUrl, startAcpAgent } from "../src/acp/index.ts";

// Native host/SDK configuration boundary reads or forwards the host environment.
// @effect-diagnostics-next-line processEnv:off
const api = createAppApi((process.env.CONTEXT_AGENT_URL ?? defaultAppUrl).replace(/\/+$/, ""));
const connection = startAcpAgent({
  api,
  stream: ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
});
await connection.closed;
