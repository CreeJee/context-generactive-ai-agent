import { it } from "@effect/vitest";
import { Context, Effect, Layer, Stream } from "effect";
import { expect } from "vite-plus/test";
import { LayaWorkerProcess, layaWorkerProcessLayer } from "../eval/laya-worker-process.ts";

it.live("native eval process transports stdin and awaits stdout plus exit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(layaWorkerProcessLayer);
      const process = Context.get(services, LayaWorkerProcess);
      const handle = yield* process.spawn({
        executable: globalThis.process.execPath,
        args: ["-e", "process.stdin.on('data', chunk => process.stdout.write(chunk));"],
        stdin: new TextEncoder().encode("bounded input\n"),
      });
      const output = yield* Stream.runCollect(handle.stdout.pipe(Stream.decodeText()));
      expect(output.join("")).toBe("bounded input\n");
      expect(yield* handle.exitCode).toBe(0);
      expect(yield* handle.isRunning).toBe(false);
    }),
  ),
);

it.live("native eval process scope kills and reaps an unfinished child", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(layaWorkerProcessLayer);
    const process = Context.get(services, LayaWorkerProcess);
    const handle = yield* Effect.scoped(
      process.spawn({
        executable: globalThis.process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        stdin: new Uint8Array(),
      }),
    );
    expect(yield* handle.isRunning).toBe(false);
    expect(yield* handle.exitCode).toBe(-1);
  }),
);
