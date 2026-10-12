import { Effect, Result } from "effect";
import { ReportDiagnoser, ReportDiagnosisInput, type ReportDiagnosisFailure } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/reports.diagnosis";

/** The browser maps these codes back to reasons without reading the rejected body. */
const diagnosisStatus = {
  model_unavailable: 503,
  model_failed: 502,
  invalid_answer: 422,
} satisfies Record<ReportDiagnosisFailure, number>;

const reply = <A,>(value: A, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Optional diagnosis of the reviewed draft with the user's selected model. Only the description
 * and evidence the user included are sent. Any failure leaves the plain report usable.
 */
// Promise boundary for React Router; the diagnosis runs in the agent runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const decoded = yield* Effect.tryPromise(() => readJson(request, ReportDiagnosisInput));
      if (Result.isFailure(decoded)) return reply({ error: "invalid_report_diagnosis" }, 400);
      const diagnoser = yield* ReportDiagnoser;
      return reply(yield* diagnoser.diagnose(decoded.success));
    }).pipe(
      Effect.catchTags({
        ReportDiagnosisError: (error) =>
          Effect.succeed(
            reply(
              { error: "report_diagnosis_failed", reason: error.reason },
              diagnosisStatus[error.reason],
            ),
          ),
        UnknownError: () => Effect.succeed(reply({ error: "invalid_report_diagnosis" }, 400)),
      }),
    ),
  );
}
