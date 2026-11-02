import { imageRouteContracts, productionImageRouteContracts } from "memory-agent";
import { describe, expect, it } from "vite-plus/test";

describe("image route contracts", () => {
  it("requires both verification and an explicit production flag", () => {
    const candidate = imageRouteContracts[0]!;
    expect(
      productionImageRouteContracts([
        { ...candidate, verification: "verified", productionEnabled: false },
        { ...candidate, verification: "unverified", productionEnabled: true },
        { ...candidate, verification: "verified", productionEnabled: true },
      ]),
    ).toHaveLength(1);
  });
});
