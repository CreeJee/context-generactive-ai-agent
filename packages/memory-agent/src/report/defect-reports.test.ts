import { describe, expect, it } from "@effect/vitest";
import { Array as Arr, Duration, Option } from "effect";
import {
  admitDefect,
  fingerprintWindow,
  messagesPerMinute,
  noDefectsSent as empty,
} from "./defect-reports.ts";

describe("admitDefect", () => {
  it("sends a fingerprint once per window and counts the occurrences held back", () => {
    const first = admitDefect(empty, "TypeError@loop", 0);
    expect(first.count).toEqual(Option.some(1));
    const second = admitDefect(first.state, "TypeError@loop", 1_000);
    const third = admitDefect(second.state, "TypeError@loop", 2_000);
    expect([second.count, third.count]).toEqual([Option.none(), Option.none()]);
    const later = admitDefect(third.state, "TypeError@loop", Duration.toMillis(fingerprintWindow));
    expect(later.count).toEqual(Option.some(3));
  });

  it("caps the messages per minute across fingerprints", () => {
    const [state, counts] = Arr.mapAccum(
      Array.from({ length: messagesPerMinute + 1 }, (_, index) => index),
      empty,
      (sent, index) => {
        const admitted = admitDefect(sent, `Defect@step${index}`, index);
        return [admitted.state, Option.isSome(admitted.count)];
      },
    );
    expect(counts.filter(Boolean)).toHaveLength(messagesPerMinute);
    expect(admitDefect(state, "Defect@late", 60_000).count).toEqual(Option.some(1));
  });
});
