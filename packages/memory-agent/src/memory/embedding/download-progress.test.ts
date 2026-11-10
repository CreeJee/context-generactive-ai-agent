import type { ProgressInfo } from "@huggingface/transformers";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { downloadProgress, type LoadReport } from "./download-progress.ts";

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

  const file = (name: string, loaded: number, total: number): LoadReport => ({
    status: "progress",
    name: "m",
    progress: 0,
    file: name,
    loaded,
    total,
  });
  const collected = (reports: readonly LoadReport[]) =>
    Stream.runCollect(downloadProgress(Stream.fromIterable(reports)));

  it("counts a planned download's whole size from its start", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* collected([
            {
              status: "planned",
              files: {
                "tokenizer.json": { loaded: 0, total: 100 },
                "onnx/model.onnx": { loaded: 0, total: 1000 },
              },
            },
            // Cached: read in one report, and not part of the plan.
            file("config.json", 5, 5),
            file("tokenizer.json", 100, 100),
            file("onnx/model.onnx", 500, 1000),
            file("onnx/model.onnx", 1000, 1000),
          ]),
        ).toEqual([
          { loaded: 0, total: 1100 },
          { loaded: 100, total: 1100 },
          { loaded: 600, total: 1100 },
          { loaded: 1100, total: 1100 },
        ]);
      }),
    ));

  it("reports nothing when every file is cached, and unknown sizes when they could not be read", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* collected([
            { status: "planned", files: {} },
            file("tokenizer.json", 100, 100),
            file("onnx/model.onnx", 1000, 1000),
          ]),
        ).toEqual([]);
        expect(yield* collected([{ status: "unplanned" }])).toEqual([{ loaded: 0, total: 0 }]);
      }),
    ));
});
