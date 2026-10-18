import { Console, Deferred, Effect } from "effect";
import { CliConfig, CliOutput, Command } from "effect/cli";

/**
 * Parses `args` into the values of `config` with no Effect CLI built-in flags (`--help`,
 * `--version`, `--completions`, ...): each entry point keeps its own options and usage text.
 * Parse errors render `usage` and the parse details on stderr, then fail with the `CliError`:
 * stdout may be a protocol channel (`acp`).
 */
export const parseCommandLine = Effect.fnUntraced(function* <
  const Config extends Command.Command.Config,
>(name: string, config: Config, usage: string, args: ReadonlyArray<string>) {
  const parsed = yield* Deferred.make<Command.Command.Config.Infer<Config>>();
  const command = Command.make(name, config, (input) =>
    Effect.asVoid(Deferred.succeed(parsed, input)),
  );
  const formatter = CliOutput.defaultFormatter();
  // effect/cli prints help with `Console.log`; send it to stderr like the errors.
  const console = yield* Console.Console;
  yield* Command.runWith(command, { version: "" })(args).pipe(
    Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns: [] })),
    Effect.provideService(
      Console.Console,
      Object.assign(Object.create(console), {
        log: (...args: ReadonlyArray<unknown>) => console.error(...args),
      }),
    ),
    Effect.provideService(CliOutput.Formatter, {
      formatHelpDoc: () => usage,
      formatCliError: formatter.formatCliError,
      formatError: formatter.formatError,
      formatErrors: formatter.formatErrors,
      formatVersion: formatter.formatVersion,
    }),
  );
  // Without built-in action flags a successful parse always reaches the handler.
  return yield* Deferred.await(parsed);
});
