import { NodePath } from "@effect/platform-node";
import { ManagedRuntime, Path } from "effect";
import { Effect, Option, Schema } from "effect";
import { Argument, Flag } from "effect/cli";
import { parseCommandLine } from "../server/command-line.ts";

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

export const readDevConfiguration = Effect.fn("dev.readConfiguration")(function* (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  app: string,
) {
  const parsed = yield* parseCommandLine("dev", devCommandLine, devHelp, args).pipe(
    Effect.mapError(() =>
      DevConfigurationError.make({ detail: "Invalid dev arguments; use --help." }),
    ),
  );
  const { mode } = parsed;
  const port = Effect.fnUntraced(function* (value: string, name: string) {
    return yield* Schema.decodeEffect(Port)(Number(value)).pipe(
      Effect.mapError(() =>
        DevConfigurationError.make({ detail: `${name} must be an integer from 1 to 65535.` }),
      ),
    );
  });
  const backendPort = yield* port(
    Option.getOrUndefined(parsed.backendPort) ??
      environment.CONTEXT_AGENT_DEV_BACKEND_PORT ??
      "5180",
    "backend-port",
  );
  const webPort = yield* port(
    Option.getOrUndefined(parsed.webPort) ?? environment.CONTEXT_AGENT_DEV_WEB_PORT ?? "5173",
    "web-port",
  );
  if (mode === "all" && backendPort === webPort)
    return yield* DevConfigurationError.make({
      detail: "Backend and web ports must differ in all mode.",
    });
  const storage = Option.getOrUndefined(parsed.storage) ?? environment.CONTEXT_AGENT_HOME;
  const manifest = Option.getOrUndefined(parsed.manifest) ?? environment.CONTEXT_AGENT_DEV_MANIFEST;
  return {
    mode,
    help: parsed.help,
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

const devCommandLine = {
  mode: Argument.Literals("mode", ["all", "agent", "web"]).pipe(Argument.withDefault("all")),
  backendPort: Flag.String("backend-port").pipe(Flag.optional),
  webPort: Flag.String("web-port").pipe(Flag.optional),
  storage: Flag.String("storage").pipe(Flag.optional),
  manifest: Flag.String("manifest").pipe(Flag.optional),
  help: Flag.Boolean("help").pipe(Flag.withAlias("h"), Flag.withDefault(false)),
};
