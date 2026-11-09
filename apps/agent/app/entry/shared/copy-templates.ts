// Situations app copy is written for. A feature's copy.ts fills one of these shapes, so the same
// situation always says the same parts in the same order.

/** A question asked before something runs: what will happen, and one label per choice. */
export interface ConfirmCopy<Choice extends string> {
  readonly title: string;
  readonly body: string;
  readonly choices: { readonly [Key in Choice]: string };
}

/** A failure the user can act on: what did not happen, then what to check or do. */
export interface ProblemCopy {
  readonly what: string;
  readonly next: string;
}

/** A problem as one line, for places that show a single message. */
export function problemText(copy: ProblemCopy): string {
  return `${copy.what} ${copy.next}`;
}
