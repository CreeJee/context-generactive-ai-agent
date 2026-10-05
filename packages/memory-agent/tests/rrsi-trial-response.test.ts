import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { readTrialAnswer } from "../src/rrsi/trial-response.ts";

const frame = (chunk: { type: string; delta?: string; message?: string }) =>
  `data: ${JSON.stringify(chunk)}\n\n`;
test("only a finished run produces a scorable answer", async () => {
  const text = frame({ type: "TEXT_MESSAGE_CONTENT", delta: "evidence" });
  expect(await Effect.runPromise(readTrialAnswer(text + frame({ type: "RUN_FINISHED" })))).toBe(
    "evidence",
  );
  const incomplete = await Effect.runPromise(Effect.flip(readTrialAnswer(text)));
  expect(incomplete.reason).toBe("evaluation_incomplete");
  const failed = await Effect.runPromise(
    Effect.flip(
      readTrialAnswer(text + frame({ type: "RUN_ERROR", message: "private provider details" })),
    ),
  );
  expect(failed.reason).toBe("trial_execution_failed");
  expect(JSON.stringify(failed)).not.toContain("private provider details");
});
