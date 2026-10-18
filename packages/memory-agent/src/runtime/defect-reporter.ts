import { Cause, Context, Effect } from "effect";

/** A defect an owner recorded instead of letting it end the process. */
export interface DefectEvent {
  /** What the owner was doing, as its log message names it. */
  readonly message: string;
  readonly annotations: Readonly<Record<string, string>>;
  readonly cause: Cause.Cause<unknown>;
}

/**
 * Where `logDefect` hands every defect it logs. Nothing is sent until the app provides the Discord
 * reporter (`report/defect-reports.ts`); tests and the import worker keep the default.
 */
export const DefectReporter = Context.Reference<{
  readonly report: (event: DefectEvent) => Effect.Effect<void>;
}>("memory-agent/runtime/defect-reporter/DefectReporter", {
  defaultValue: () => ({ report: () => Effect.void }),
});
