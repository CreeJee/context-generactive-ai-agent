import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { platform } from "node:os";

/** What the host's folder dialog answered. */
export const FolderPick = Schema.TaggedUnion({
  picked: { root: Schema.String },
  cancelled: {},
  /** No dialog on this host (no GUI tool, or it failed to start): the path is typed instead. */
  unavailable: {},
});
export type FolderPick = typeof FolderPick.Type;

const prompt = "프로젝트로 열 폴더를 고르세요";

interface Dialog {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Exit codes that mean the user closed the dialog without choosing. */
  readonly cancelCodes: ReadonlyArray<number>;
}

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
} satisfies Partial<Record<NodeJS.Platform, ReadonlyArray<Dialog>>>;

const dialogsFor = (platform: NodeJS.Platform): ReadonlyArray<Dialog> =>
  platform === "darwin" || platform === "win32" || platform === "linux" ? dialogs[platform] : [];

/** One dialog run, scoped so an interrupted request closes it. `null`: it could not start. */
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
      return { stdout, exitCode: Number(exitCode) };
    }),
  ).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(null)));

/**
 * Opens the host's native folder dialog. The dialog shows on the machine running the server,
 * which is the user's own for this local app. The answer is only a path: registering it still
 * goes through `Projects.add` and its checks.
 */
export const pickFolder = Effect.fn("FolderPicker.pick")(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const dialog of dialogsFor(yield* Effect.sync(platform))) {
    const output = yield* run(dialog);
    if (output === null) continue;
    if (dialog.cancelCodes.includes(output.exitCode)) return FolderPick.cases.cancelled.make({});
    if (output.exitCode !== 0) return FolderPick.cases.unavailable.make({});
    const chosen = output.stdout.trim();
    if (chosen === "") return FolderPick.cases.cancelled.make({});
    // osascript ends folders with "/"; the registered root is the canonical path without it.
    const root = yield* fs
      .realPath(chosen)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(chosen)));
    return FolderPick.cases.picked.make({ root });
  }
  return FolderPick.cases.unavailable.make({});
});
