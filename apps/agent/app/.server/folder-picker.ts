import { Effect, FileSystem, Match, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FolderPick } from "memory-agent";
import { platform } from "node:os";

const prompt = "프로젝트로 열 폴더를 고르세요";

interface Dialog {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Exit codes that mean the user closed the dialog without choosing. */
  readonly cancelCodes: ReadonlyArray<number>;
}

/** Hosts with a known folder dialog. */
const DialogHost = Schema.Literals(["darwin", "win32", "linux"]);

const dialogs = {
  // `activate` brings the dialog in front of the browser; -128 (exit 1) is "User canceled".
  darwin: [
    {
      command: "osascript",
      args: [
        "-e",
        "tell current application to activate",
        "-e",
        `POSIX path of (choose folder with prompt "${prompt}")`,
      ],
      cancelCodes: [1],
    },
  ],
  win32: [
    {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-STA",
        "-Command",
        [
          "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
          "Add-Type -AssemblyName System.Windows.Forms",
          "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
          `$dialog.Description = '${prompt}'`,
          "if ($dialog.ShowDialog() -eq 'OK') { [Console]::Out.Write($dialog.SelectedPath) } else { exit 1 }",
        ].join("; "),
      ],
      cancelCodes: [1],
    },
  ],
  // zenity and kdialog both exit 1 when cancelled; the first one installed is used.
  linux: [
    {
      command: "zenity",
      args: ["--file-selection", "--directory", `--title=${prompt}`],
      cancelCodes: [1],
    },
    {
      command: "kdialog",
      args: ["--getexistingdirectory", ".", "--title", prompt],
      cancelCodes: [1],
    },
  ],
} satisfies Record<typeof DialogHost.Type, ReadonlyArray<Dialog>>;

/**
 * One dialog run, scoped so an interrupted request closes it. Fails with `PlatformError` when it
 * could not start, so the next dialog is tried.
 */
const run = (dialog: Dialog) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(dialog.command, dialog.args, {
          windowsHide: true,
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
        { concurrency: 2 },
      );
      return { chosen: stdout.trim(), exitCode: Number(exitCode) };
    }),
  );

// osascript ends folders with "/"; the registered root is the canonical path without it.
const canonical = (chosen: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(chosen)).pipe(
    Effect.catchTag("PlatformError", () => Effect.succeed(chosen)),
  );

/** Reads one dialog's exit. An empty answer on success is a closed dialog too. */
const answer = (
  dialog: Dialog,
  { chosen, exitCode }: { readonly chosen: string; readonly exitCode: number },
) =>
  Match.value(exitCode).pipe(
    Match.when(
      (code) => dialog.cancelCodes.includes(code),
      () => Effect.succeed(FolderPick.cases.cancelled.make({})),
    ),
    Match.when(0, () =>
      chosen === ""
        ? Effect.succeed(FolderPick.cases.cancelled.make({}))
        : Effect.map(canonical(chosen), (root) => FolderPick.cases.picked.make({ root })),
    ),
    Match.orElse(() => Effect.succeed(FolderPick.cases.unavailable.make({}))),
  );

const ask = (dialog: Dialog) => Effect.flatMap(run(dialog), (output) => answer(dialog, output));

/**
 * Opens the host's native folder dialog. The dialog shows on the machine running the server,
 * which is the user's own for this local app. The answer is only a path: registering it still
 * goes through `Projects.add` and its checks.
 */
export const pickFolder = Effect.fn("FolderPicker.pick")(function* () {
  const host = yield* Effect.sync(platform);
  const asked = Schema.is(DialogHost)(host) ? dialogs[host].map(ask) : [];
  // The first dialog that starts answers; when none does, the path is typed instead.
  return yield* Effect.firstSuccessOf([
    ...asked,
    Effect.succeed(FolderPick.cases.unavailable.make({})),
  ]);
});
