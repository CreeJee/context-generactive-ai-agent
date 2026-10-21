import { describe, expect, it } from "vite-plus/test";
import { GpuCheck } from "../../config/global-config.ts";
import { embeddingModeFor, gpuMemoryThreshold, planBatches } from "./embedder.ts";

describe("how the model runs", () => {
  const plenty = gpuMemoryThreshold;
  const little = gpuMemoryThreshold - 1;
  const available = GpuCheck.cases.available.make({ checkedAt: "2026-09-16T00:00:00.000Z" });
  const unavailable = GpuCheck.cases.unavailable.make({
    checkedAt: "2026-09-16T00:00:00.000Z",
    reason: "no WebGPU device",
  });

  it("auto takes the GPU only with enough memory and a WebGPU that worked", () => {
    expect(embeddingModeFor({}, plenty)).toBe("cpu");
    expect(embeddingModeFor({ gpuCheck: available }, plenty)).toBe("gpu");
    expect(embeddingModeFor({ gpuCheck: available }, little)).toBe("cpu");
    expect(embeddingModeFor({ gpuCheck: unavailable }, plenty)).toBe("cpu");
  });

  it("a choice the user made is kept whatever the machine", () => {
    expect(embeddingModeFor({ embeddingDevice: "gpu", gpuCheck: unavailable }, little)).toBe("gpu");
    expect(embeddingModeFor({ embeddingDevice: "cpu", gpuCheck: available }, plenty)).toBe("cpu");
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
