import { expect, test } from "vite-plus/test";
import { CancellationReason, EvaluationFailed, experimentFailure } from "../src/rrsi/failure.ts";

test.each(CancellationReason.literals)(
  "cancellation %s takes precedence over container termination",
  (reason) => {
    const abort = new AbortController();
    abort.abort(reason);
    expect(
      experimentFailure(
        new EvaluationFailed({ reason: "evaluation_container_failed" }),
        abort.signal,
      ),
    ).toBe(reason);
  },
);

test("untrusted provider messages and abort payloads never enter experiment records", () => {
  const secret = "https://private-endpoint.invalid secret-token private-model";
  const abort = new AbortController();
  expect(experimentFailure(new Error(secret), abort.signal)).toBe("evaluation_failed");
  expect(
    experimentFailure(new EvaluationFailed({ reason: "gateway_request_failed" }), abort.signal),
  ).toBe("gateway_request_failed");
  abort.abort(secret);
  expect(experimentFailure(new Error(secret), abort.signal)).toBe("experiment_stopped");
});
