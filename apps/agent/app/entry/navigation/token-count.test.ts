import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { formatTokenCount, parseTokenCount } from "./token-count";

describe("token counts", () => {
  it("reads digits and binary K/M suffixes", () => {
    expect(parseTokenCount("131072")).toEqual(Option.some(131_072));
    expect(parseTokenCount("131,072")).toEqual(Option.some(131_072));
    expect(parseTokenCount("128k")).toEqual(Option.some(131_072));
    expect(parseTokenCount(" 128 K ")).toEqual(Option.some(131_072));
    expect(parseTokenCount("1M")).toEqual(Option.some(1_048_576));
    expect(parseTokenCount("1.5m")).toEqual(Option.some(1_572_864));
  });

  it("reads anything else as no count", () => {
    expect(parseTokenCount("")).toEqual(Option.none());
    expect(parseTokenCount("128g")).toEqual(Option.none());
    expect(parseTokenCount("-1")).toEqual(Option.none());
    expect(parseTokenCount("k")).toEqual(Option.none());
  });

  it("names a count by its exact unit and keeps uneven counts as digits", () => {
    expect(formatTokenCount(131_072)).toBe("128K");
    expect(formatTokenCount(1_048_576)).toBe("1M");
    expect(formatTokenCount(1_572_864)).toBe("1536K");
    expect(formatTokenCount(65_565)).toBe("65,565");
    expect(formatTokenCount(100_000)).toBe("100,000");
    expect(formatTokenCount(512)).toBe("512");
  });
});
