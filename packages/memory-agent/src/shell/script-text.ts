import { Array as Arr, HashSet, Result } from "effect";

/**
 * A sh script read as text, without running or parsing it as a shell would: its lines, and the
 * command each of its steps starts with. The refusals and the routine check that read a script
 * this way are deliberately loose, so none of them is a safety decision by itself.
 */

/** Words that run nothing of their own; the program after them is what counts. */
const prefixes = HashSet.make("command", "exec", "env", "time", "nice");
/** Steps that only set up the shell. */
const setup = HashSet.make("cd", "set", "export", "true", ":", "echo", "printf", "exit");

/** A script's lines that say something: trimmed, without blank lines and comments. */
export const scriptLines = (script: string): ReadonlyArray<string> =>
  Arr.filterMap(script.split("\n"), (line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#") ? Result.succeed(trimmed) : Result.failVoid;
  });

/** One step of a script: the first command of what runs between `;`, `&&` and `||`. */
export interface ScriptStep {
  /** The program's name, without the folder it was named in. */
  readonly program: string;
  /** The command from its program on, up to the first pipe, its words joined by single spaces. */
  readonly text: string;
}

/** The steps of a script that run a program; a step that only sets up the shell is left out. */
export const scriptSteps = (script: string): ReadonlyArray<ScriptStep> =>
  Arr.filterMap(
    scriptLines(script).flatMap((line) => line.split(/;|&&|\|\|/)),
    (step) => {
      const words = (step.split("|")[0] ?? "").trim().split(/\s+/);
      const command = Arr.dropWhile(
        words,
        (word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || HashSet.has(prefixes, word),
      );
      const program = (command[0] ?? "").split("/").at(-1) ?? "";
      return program !== "" && !HashSet.has(setup, program)
        ? Result.succeed({ program, text: command.join(" ") })
        : Result.failVoid;
    },
  );
