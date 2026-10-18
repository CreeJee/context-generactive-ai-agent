import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { makeLeases } from "./leases.ts";

test("one page holds a session until it lets go or stops renewing", () => {
  let clock = 1_000;
  const leases = makeLeases(30_000, () => clock);

  expect(leases.claim("s", "tab-a")).toEqual({ claimed: true });
  expect(leases.view("s", "tab-a")).toEqual({ state: "mine" });
  expect(leases.view("s", "tab-b")).toEqual({ state: "other", since: 1_000 });
  // The second page asking loses and stays read-only.
  expect(leases.claim("s", "tab-b")).toEqual({ claimed: false, heldSince: 1_000 });
  expect(leases.permits("s", "tab-b")).toBe(false);
  expect(leases.permits("s", null)).toBe(false);

  // Renewing keeps it; a page that stops renewing loses it.
  clock += 20_000;
  leases.claim("s", "tab-a");
  clock += 20_000;
  expect(leases.view("s", "tab-b").state).toBe("other");
  clock += 30_000;
  expect(leases.view("s", "tab-b")).toEqual({ state: "free" });
  expect(leases.claim("s", "tab-b")).toEqual({ claimed: true });
  expect(leases.view("s", "tab-a").state).toBe("other");

  // Only the holder can release.
  leases.release("s", "tab-a");
  expect(leases.view("s", "tab-b")).toEqual({ state: "mine" });
  leases.release("s", "tab-b");
  expect(leases.view("s", "tab-a")).toEqual({ state: "free" });
});

test("expired leases are reclaimed even when their sessions are not requested again", () => {
  let clock = 0;
  const leases = makeLeases(100, () => clock);
  leases.claim("old", "tab-a");
  clock = 50;
  leases.claim("fresh", "tab-b");
  clock = 110;
  const freed: string[] = [];
  leases.onExpired((sessionId) => Effect.sync(() => freed.push(sessionId)));
  expect(Effect.runSync(leases.sweepExpired)).toEqual(["old"]);
  expect(freed).toEqual(["old"]);
  expect(leases.view("old", "tab-a")).toEqual({ state: "free" });
  expect(leases.view("fresh", "tab-b")).toEqual({ state: "mine" });
});
