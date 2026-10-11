// Independent HTTP client for the finite service benchmark; no application state.
import { parentPort } from "node:worker_threads";

export type ProbeMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "started" }
  | {
      readonly kind: "done";
      readonly milliseconds: readonly number[];
      readonly statuses: readonly number[];
    }
  | { readonly kind: "failed" };

parentPort?.on("message", async (url: string) => {
  parentPort!.postMessage({ kind: "started" } satisfies ProbeMessage);
  try {
    const samples = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const milliseconds: number[] = [];
        const statuses: number[] = [];
        for (let iteration = 0; iteration < 5; iteration++) {
          const started = performance.now();
          const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          await response.text();
          milliseconds.push(performance.now() - started);
          statuses.push(response.status);
        }
        return { milliseconds, statuses };
      }),
    );
    parentPort!.postMessage({
      kind: "done",
      milliseconds: samples.flatMap((sample) => sample.milliseconds),
      statuses: samples.flatMap((sample) => sample.statuses),
    } satisfies ProbeMessage);
  } catch {
    parentPort!.postMessage({ kind: "failed" } satisfies ProbeMessage);
  }
});
parentPort?.postMessage({ kind: "ready" } satisfies ProbeMessage);
