import { NodePath } from "@effect/platform-node";
import { ManagedRuntime, Path } from "effect";
import { Effect, Schema } from "effect";
// Node CLI/environment boundary; no application runtime or storage is opened here.
import { parseArgs } from "node:util";

const { resolve, join } = ManagedRuntime.make(NodePath.layer).runSync(Path.Path);

export class DevConfigurationError extends Schema.TaggedError<DevConfigurationError>()(
  "DevConfigurationError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

const Port = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65535));
const Mode = Schema.Literals(["all", "agent", "web"]);

export const readDevConfiguration = Effect.fn("dev.readConfiguration")(function* (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  app: string,
) {
  const parsed = yield* Effect.try({
    try: () =>
      parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
          "backend-port": { type: "string" },
          "web-port": { type: "string" },
          storage: { type: "string" },
          manifest: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    catch: () => DevConfigurationError.make({ detail: "Invalid dev arguments; use --help." }),
  });
  const mode = yield* Schema.decodeUnknownEffect(Mode)(parsed.positionals[0] ?? "all").pipe(
    Effect.mapError(() =>
      DevConfigurationError.make({ detail: "Dev mode must be all, agent or web." }),
    ),
  );
  if (parsed.positionals.length > 1)
    return yield* DevConfigurationError.make({ detail: "Only one dev mode may be specified." });
  const port = Effect.fnUntraced(function* (value: string, name: string) {
    return yield* Schema.decodeEffect(Port)(Number(value)).pipe(
      Effect.mapError(() =>
        DevConfigurationError.make({ detail: `${name} must be an integer from 1 to 65535.` }),
      ),
    );
  });
  const backendPort = yield* port(
    parsed.values["backend-port"] ?? environment.CONTEXT_AGENT_DEV_BACKEND_PORT ?? "5180",
    "backend-port",
  );
  const webPort = yield* port(
    parsed.values["web-port"] ?? environment.CONTEXT_AGENT_DEV_WEB_PORT ?? "5173",
    "web-port",
  );
  if (mode === "all" && backendPort === webPort)
    return yield* DevConfigurationError.make({
      detail: "Backend and web ports must differ in all mode.",
    });
  const storage = parsed.values.storage ?? environment.CONTEXT_AGENT_HOME;
  const manifest = parsed.values.manifest ?? environment.CONTEXT_AGENT_DEV_MANIFEST;
  return {
    mode,
    help: parsed.values.help ?? false,
    backendPort,
    webPort,
    storage: storage === undefined ? undefined : resolve(storage),
    manifestFile:
      manifest === undefined
        ? join(app, "build", `dev-backend-${backendPort}.json`)
        : resolve(manifest),
  };
});

export const devHelp = `Usage: vp run dev [all|agent|web] [options]
  --backend-port <port>  Backend port (default 5180)
  --web-port <port>      HMR frontend port (default 5173)
  --storage <directory> Isolated storage root (default application storage)
  --manifest <file>     Backend connection file shared by agent/web terminals
  -h, --help            Show configuration help without starting servers
CLI options override CONTEXT_AGENT_DEV_BACKEND_PORT, CONTEXT_AGENT_DEV_WEB_PORT,
CONTEXT_AGENT_HOME and CONTEXT_AGENT_DEV_MANIFEST. Backend changes require a manual restart.`;
