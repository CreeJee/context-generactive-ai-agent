import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { GpuCheck } from "../../config/contracts.ts";
import { currentGpuCheck, embeddingModeFor, gpuModelFile, planBatches } from "./embedder.ts";

describe("how the model runs", () => {
  const available = GpuCheck.cases.available.make({
    checkedAt: "2026-09-16T00:00:00.000Z",
    model: gpuModelFile,
  });
  const unavailable = GpuCheck.cases.unavailable.make({
    checkedAt: "2026-09-16T00:00:00.000Z",
    reason: "no WebGPU device",
    model: gpuModelFile,
  });

  it("auto runs the gpu mode, which falls back to the CPU by itself, whatever WebGPU did", () => {
    expect(embeddingModeFor({})).toBe("gpu");
    expect(embeddingModeFor({ gpuCheck: unavailable })).toBe("gpu");
  });

  it("a choice the user made is kept whatever WebGPU did", () => {
    expect(embeddingModeFor({ embeddingDevice: "gpu", gpuCheck: unavailable })).toBe("gpu");
    expect(embeddingModeFor({ embeddingDevice: "cpu", gpuCheck: available })).toBe("cpu");
  });

  it("a WebGPU check of another model file is not this file's", () => {
    const otherFile = {
      ...available,
      model: "ibm-granite/granite-embedding-97m-multilingual-r2/onnx/model.onnx",
    };
    const { model: _, ...unnamed } = available;
    expect(currentGpuCheck({ gpuCheck: available })).toEqual(Option.some(available));
    expect(currentGpuCheck({ gpuCheck: otherFile })).toEqual(Option.none());
    expect(currentGpuCheck({ gpuCheck: unnamed })).toEqual(Option.none());
  });
});

describe("embedding batches", () => {
  it("group texts by length so a long text is never padded together with many short ones", () => {
    const limits = { size: 4, cost: 100 * 100 };
    // Short texts fill a batch up to the size; a long one goes alone; order within is shortest first.
    expect(planBatches([10, 90, 12, 11, 13, 14], limits)).toEqual([[0, 3, 2, 4], [5], [1]]);
    expect(planBatches([100, 100], limits)).toEqual([[0], [1]]);
    expect(planBatches([50, 50, 50, 50, 50], limits)).toEqual([[0, 1, 2, 3], [4]]);
    expect(planBatches([], limits)).toEqual([]);
  });
});
