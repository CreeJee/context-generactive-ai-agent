// The app's production entry: `context-agent [folder]` serves the web app, runs the agent in this
// process and opens the folder (or the folder it was started from) as a project;
// `context-agent acp` is the stdio ACP agent editors start, working through that server.
// Runs as the packaged executable (Node SEA) or as the `vp pack` bundle (`vp run start`).
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isSea } from "node:sea";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { defaultStorageRoot } from "memory-agent";
import { createAppApi, startAcpAgent } from "memory-agent/acp";
import * as build from "#server-build";
import { isThisApp, launchFolder, openProject, type LaunchFolder } from "./launch-project.ts";
import { readReleaseInfo } from "./release-info.ts";
import { unpackRuntime } from "./runtime-assets.ts";
import { acquireStorageLock } from "./dev-safety.ts";
import { openInBrowser, serve } from "./serve.ts";

const usage = `사용법:
  context-agent [폴더] [--port 5173] [--no-open] [--storage <폴더>]
      폴더(없으면 실행한 위치)를 프로젝트로 열어요. 앱이 이미 실행 중이면 그 앱에서 열어요.
  context-agent acp [--port 5173]
      에디터(Zed 등)용 ACP 에이전트(실행 중인 앱에 연결)
  context-agent --version
      실행 파일의 버전, 릴리스 채널과 대상 플랫폼을 표시해요.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    port: { type: "string", default: "5173" },
    open: { type: "boolean", default: true },
    storage: { type: "string" },
    "dev-backend": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
});

if (values.version) {
  const release = readReleaseInfo();
  console.log(`context-agent ${release.version} (${release.channel}, ${release.target})`);
  process.exit(0);
}

const port = Number(values.port);
if (values.help || !Number.isInteger(port) || port < 1 || port > 65_535 || positionals.length > 1) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}
const baseUrl = `http://127.0.0.1:${port}`;

/** Opens the launch folder on the app at `baseUrl` and returns the page to show. */
async function pageFor(folder: LaunchFolder) {
  switch (folder.kind) {
    case "none":
    case "invalid":
      return baseUrl;
    case "folder": {
      const opened = await openProject(baseUrl, folder.root);
      switch (opened.kind) {
        case "opened":
          console.log(
            `${opened.added ? "프로젝트로 추가했어요" : "등록된 프로젝트예요"}: ${folder.root}`,
          );
          return `${baseUrl}/?project=${encodeURIComponent(opened.projectId)}`;
        case "rejected":
          console.error(`이 폴더는 프로젝트로 열 수 없어요(${opened.reason}): ${folder.root}`);
          return baseUrl;
      }
    }
  }
}

if (positionals[0] === "acp") {
  // stdout is the protocol channel: nothing else may be written to it.
  const api = createAppApi(baseUrl);
  // SAFETY: stdin without an encoding set emits Buffer chunks, which are Uint8Arrays.
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const connection = startAcpAgent({
    api,
    stream: ndJsonStream(Writable.toWeb(process.stdout), input),
  });
  await connection.closed;
} else {
  const storageRoot = values.storage ?? defaultStorageRoot;
  // Only the executable has a folder of its own; `node` running the bundle does not count.
  const executableFolder = isSea() ? dirname(process.execPath) : null;
  const folder: LaunchFolder = values["dev-backend"]
    ? { kind: "none" }
    : launchFolder(positionals[0], process.cwd(), storageRoot, executableFolder);
  if (folder.kind === "invalid") {
    console.error(`폴더를 찾을 수 없어요: ${folder.path}`);
    process.exit(2);
  }

  if (await isThisApp(baseUrl)) {
    // One server per storage root: a second start hands the folder to the running app.
    const page = await pageFor(folder);
    console.log(`이미 실행 중인 앱(${baseUrl})에서 열었어요.`);
    if (values.open) openInBrowser(page);
    process.exit(0);
  }

  process.env.CONTEXT_AGENT_HOME = storageRoot;
  const developmentBuildId = process.env.CONTEXT_AGENT_BUILD_ID;
  const runtimeInstanceId = randomUUID();
  const releaseStorageLock = acquireStorageLock(storageRoot, port, runtimeInstanceId);
  process.once("exit", releaseStorageLock);
  const runtime = unpackRuntime(storageRoot);
  if (runtime !== null) process.env.CONTEXT_AGENT_RUNTIME = runtime;
  const clientDirectory =
    runtime === null
      ? fileURLToPath(new URL("../build/client", import.meta.url))
      : `${runtime}/client`;
  await serve({
    build,
    port,
    clientDirectory,
    developmentBuildId,
    runtimeInstanceId,
  }).catch((error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `포트 ${port}를 다른 프로그램이 쓰고 있어요. --port로 다른 포트를 지정하세요.`
        : `서버를 시작하지 못했어요: ${error.message}`,
    );
    process.exit(1);
  });
  console.log(`Context Agent가 ${baseUrl} 에서 실행 중이에요. 끝내려면 Ctrl+C.`);
  const page = await pageFor(folder);
  if (values.open) openInBrowser(page);
}
