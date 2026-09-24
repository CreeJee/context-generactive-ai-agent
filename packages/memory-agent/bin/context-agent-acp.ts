#!/usr/bin/env node
// ACP agent for editors (Zed and others): speaks ACP on stdin/stdout and works through the running
// context-generactive-agent app. Set CONTEXT_AGENT_URL when the app is not on the default address.
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createAppApi, defaultAppUrl, startAcpAgent } from "../src/acp/index.ts";

const api = createAppApi((process.env.CONTEXT_AGENT_URL ?? defaultAppUrl).replace(/\/+$/, ""));
const connection = startAcpAgent({
  api,
  stream: ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
});
await connection.closed;
