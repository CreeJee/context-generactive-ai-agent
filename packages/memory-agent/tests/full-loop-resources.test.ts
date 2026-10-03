import { Effect, Exit, Scope } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { acquireFullLoopChannel } from "../src/agent/full-loop-resources.ts";

test("channel finalization closes the second native port even if the first close throws", async () => {
  const scope = Effect.runSync(Scope.make());
  const channel = await Effect.runPromise(
    acquireFullLoopChannel().pipe(Effect.provideService(Scope.Scope, scope)),
  );
  let secondClosed = false;
  channel.port2.once("close", () => {
    secondClosed = true;
  });
  const firstClose = vi.spyOn(channel.port1, "close").mockImplementation(() => {
    throw new Error("first native port close failed");
  });
  try {
    await expect(Effect.runPromise(Scope.close(scope, Exit.void))).rejects.toThrow();
    await vi.waitFor(() => expect(secondClosed).toBe(true));
    expect(firstClose).toHaveBeenCalledTimes(1);
  } finally {
    firstClose.mockRestore();
    channel.port1.close();
    channel.port2.close();
  }
});
