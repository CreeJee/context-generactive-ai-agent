// The app's production entry: `context-agent` serves the web app and runs the agent in this
// process; `context-agent acp` is the stdio ACP agent editors start, working through that server.
// Runs as the packaged executable (Node SEA) or as `node server/main.ts` after `react-router build`.
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { defaultStorageRoot } from "memory-agent";
import { AppApi, startAcpAgent } from "memory-agent/acp";
import * as build from "#server-build";
import { unpackRuntime } from "./runtime-assets.ts";
import { serve } from "./serve.ts";

const usage = `사용법:
  context-agent [--port 5173] [--no-open] [--storage <폴더>]
  context-agent acp [--port 5173]     에디터(Zed 등)용 ACP 에이전트(실행 중인 앱에 연결)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    port: { type: "string", default: "5173" },
    open: { type: "boolean", default: true },
    storage: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const port = Number(values.port);
if (values.help || !Number.isInteger(port) || port < 1 || port > 65_535 || positionals.length > 1) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}

switch (positionals[0]) {
  case "acp": {
    // stdout is the protocol channel: nothing else may be written to it.
    const api = new AppApi(`http://127.0.0.1:${port}`);
    // SAFETY: stdin without an encoding set emits Buffer chunks, which are Uint8Arrays.
    const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
    const connection = startAcpAgent({
      api,
      stream: ndJsonStream(Writable.toWeb(process.stdout), input),
    });
    await connection.closed;
    break;
  }
  case undefined: {
    const storageRoot = values.storage ?? defaultStorageRoot;
    process.env.CONTEXT_AGENT_HOME = storageRoot;
    const runtime = unpackRuntime(storageRoot);
    if (runtime !== null) process.env.CONTEXT_AGENT_RUNTIME = runtime;
    const clientDirectory =
      runtime === null
        ? fileURLToPath(new URL("../build/client", import.meta.url))
        : `${runtime}/client`;
    await serve({ build, port, clientDirectory, openBrowser: values.open }).catch(
      (error: NodeJS.ErrnoException) => {
        console.error(
          error.code === "EADDRINUSE"
            ? `포트 ${port}가 이미 사용 중이에요. 앱이 이미 실행 중이면 그 주소를 쓰고, 아니면 --port로 다른 포트를 지정하세요.`
            : `서버를 시작하지 못했어요: ${error.message}`,
        );
        process.exit(1);
      },
    );
    break;
  }
  default:
    console.error(usage);
    process.exit(2);
}
