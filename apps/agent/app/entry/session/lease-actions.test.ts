// Test/benchmark SDK boundary uses native Promise callbacks, I/O fixtures and synchronous codec assertions.
// @effect-diagnostics asyncFunction:off newPromise:off
import { expect, test, vi } from "vite-plus/test";
import { orderedLeaseActions } from "./lease-actions";

test("re-entry waits for the previous claim and release in the same session", async () => {
  const run = orderedLeaseActions();
  const calls: string[] = [];
  let finishClaim!: () => void;
  const claim = run("A", () => {
    calls.push("claim");
    return new Promise<void>((resolve) => {
      finishClaim = resolve;
    });
  });
  const release = run("A", async () => {
    calls.push("release");
  });
  const reentry = run("A", async () => {
    calls.push("reentry");
  });
  await Promise.resolve();
  expect(calls).toEqual(["claim"]);
  finishClaim();
  await Promise.all([claim, release, reentry]);
  expect(calls).toEqual(["claim", "release", "reentry"]);
});

test("another session does not wait for a slow lease request", async () => {
  const run = orderedLeaseActions();
  let finish!: () => void;
  const slow = run(
    "A",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const other = vi.fn(async () => "mine");
  expect(await run("B", other)).toBe("mine");
  expect(other).toHaveBeenCalledOnce();
  finish();
  await slow;
});

test("a failed release does not prevent a later claim", async () => {
  const run = orderedLeaseActions();
  const error = new Error("release failed");
  const release = run("A", async () => {
    throw error;
  });
  const claim = run("A", async () => "mine");
  await expect(release).rejects.toBe(error);
  await expect(claim).resolves.toBe("mine");
});

test("disposing the owner cancels queued actions before they acquire the lock", async () => {
  const run = orderedLeaseActions();
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    const active = run("A", () => {
      resolve();
      return new Promise<void>((done) => {
        finish = done;
      });
    });
    void active.catch(() => {});
  });
  await started;
  const queued = vi.fn(async () => "mine");
  const waiting = run("A", queued);
  const rejected = expect(waiting).rejects.toBeDefined();
  await run.dispose();
  await rejected;
  expect(queued).not.toHaveBeenCalled();
  finish();
});
