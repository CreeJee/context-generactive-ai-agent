import type { ProgressInfo } from "@huggingface/transformers";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { downloadProgress } from "./download-progress.ts";

describe("downloadProgress", () => {
  it("reports the files seen part-way, summed, once per whole percent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reports = yield* Stream.runCollect(
          downloadProgress(
            Stream.fromIterable<ProgressInfo>([
              // Read from the cache: one complete report, not a download.
              {
                status: "progress",
                name: "m",
                progress: 0,
                file: "tokenizer.json",
                loaded: 10,
                total: 10,
              },
              { status: "download", name: "m", file: "onnx/model.onnx" },
              {
                status: "progress",
                name: "m",
                progress: 0,
                file: "onnx/model.onnx",
                loaded: 100,
                total: 1000,
              },
              // Still 10%: not reported again.
              {
                status: "progress",
                name: "m",
                progress: 0,
                file: "onnx/model.onnx",
                loaded: 105,
                total: 1000,
              },
              {
                status: "progress",
                name: "m",
                progress: 0,
                file: "onnx/model.onnx_data",
                loaded: 0,
                total: 1000,
              },
              {
                status: "progress",
                name: "m",
                progress: 0,
                file: "onnx/model.onnx",
                loaded: 1000,
                total: 1000,
              },
              {
                status: "progress",
                name: "m",
                progress: 0,
                file: "onnx/model.onnx_data",
                loaded: 1000,
                total: 1000,
              },
              { status: "done", name: "m", file: "onnx/model.onnx_data" },
            ]),
          ),
        );
        expect(reports).toEqual([
          { loaded: 100, total: 1000 },
          { loaded: 105, total: 2000 },
          { loaded: 1000, total: 2000 },
          { loaded: 2000, total: 2000 },
        ]);
      }),
    ));
});
