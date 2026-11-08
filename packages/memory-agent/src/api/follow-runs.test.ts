import { Array as Arr } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { followRuns, type ReadRuns, type RunSight } from "./follow-runs.ts";

const idle = { opened: true, reading: null, sending: false } as const;

/** The sights in order, and for each whether the page read the conversation again. */
const opens = (sights: ReadonlyArray<RunSight>) =>
  Arr.mapAccum(sights, null, (read: ReadRuns, sight): readonly [ReadRuns, boolean] => {
    const next = followRuns(read, sight);
    return [next.read, next.open];
  })[1];

describe("following runs the page did not start", () => {
  test("the first read covers the newest run, and the page's own runs are not read again", () => {
    expect(
      opens([
        { ...idle, latest: undefined },
        { ...idle, latest: "before" },
        { ...idle, sending: true, latest: "before" },
        { ...idle, sending: true, reading: "own", latest: "own" },
        { ...idle, latest: "own" },
      ]),
    ).toEqual([false, false, false, false, false]);
  });

  test("a run going at the first read is the one the page joined", () => {
    expect(
      opens([
        { ...idle, latest: "going" },
        { ...idle, reading: "going", latest: "going" },
        { ...idle, latest: "going" },
      ]),
    ).toEqual([false, false, false]);
  });

  test("another tab's run is joined once", () => {
    expect(
      opens([
        { ...idle, latest: "before" },
        { ...idle, latest: "theirs" },
        { ...idle, latest: "theirs" },
        { ...idle, reading: "theirs", latest: "theirs" },
      ]),
    ).toEqual([false, true, false, false]);
  });

  test("a run started while the page reads its own waits until that ends", () => {
    expect(
      opens([
        { ...idle, latest: "before" },
        { ...idle, reading: "own", latest: "own" },
        { ...idle, reading: "own", latest: "follow-up" },
        { ...idle, latest: "follow-up" },
      ]),
    ).toEqual([false, false, false, true]);
  });

  test("a run that ended unread is read from the newest page", () => {
    expect(
      opens([
        { ...idle, latest: "before" },
        { ...idle, sending: true, latest: "missed" },
        { ...idle, latest: "missed" },
      ]),
    ).toEqual([false, false, true]);
  });
});
