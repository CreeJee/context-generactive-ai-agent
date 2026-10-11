#!/usr/bin/env node
// ACP agent for editors (Zed and others): speaks ACP on stdin/stdout and works through the running
// context-generactive-agent app. Set CONTEXT_AGENT_URL when the app is not on the default address.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { NodeStream, NodeSink } from "@effect/platform-node";
import { SdkStreams } from "../src/acp/web-streams.ts";
import { Cause as StreamCause, Context, Layer, Stream } from "effect";
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
const { readable, writable } = await Effect.runPromise(
  Effect.scoped(
    Effect.map(
      Layer.build(
        SdkStreams.layer({
          input: NodeStream.fromReadable({
            evaluate: () => process.stdin,
            onError: (cause) => new StreamCause.UnknownError(cause),
          }),
          output: NodeSink.fromWritable({
            evaluate: () => process.stdout,
            onError: (cause) => new StreamCause.UnknownError(cause),
            endOnDone: false,
          }),
          closeOutput: Stream.run(
            Stream.empty,
            NodeSink.fromWritable({
              evaluate: () => process.stdout,
              onError: (cause) => new StreamCause.UnknownError(cause),
              endOnDone: true,
            }),
          ),
        }),
      ),
      (context) => Context.get(context, SdkStreams),
    ),
  ),
);
const api = createAppApi(baseUrl);
const connection = startAcpAgent({
  api,
  stream: ndJsonStream(writable, readable),
});
await connection.closed;
