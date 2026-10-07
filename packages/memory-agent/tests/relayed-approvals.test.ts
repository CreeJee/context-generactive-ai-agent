import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Scope } from "effect";
import { expect } from "vite-plus/test";
import { RelayedApprovals, type RelayedRequest } from "../src/approvals/relayed.ts";
import { sdkCancellation } from "./support/sdk-cancellation.ts";

const request: RelayedRequest = {
  requester: { kind: "subagent", subagentId: "child", name: null },
  toolName: "write_file",
  argumentsJson: "{}",
  reason: "Approve this write",
  askedBy: "every_call",
};
const relayFixture = Effect.fnUntraced(function* () {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const services = yield* Layer.build(RelayedApprovals.layer).pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const relay = yield* Effect.provideContext(RelayedApprovals, services);
  return { relay, scope };
});
const result = <A>(promise: Promise<A>) =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new Cause.UnknownError(cause),
  });

it.live("correlates concurrent answers by request and session, and accepts each once", () =>
  Effect.gen(function* () {
    const { relay } = yield* relayFixture();
    const { controller } = yield* sdkCancellation;
    const first = relay.ask("s", request, controller.signal);
    const second = relay.ask("s", request, controller.signal);
    const [a, b] = relay.pending("s");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(relay.answer("other", b!.id, true)).toBe(false);
    expect(relay.answer("s", b!.id, true)).toBe(true);
    expect(relay.answer("s", b!.id, false)).toBe(false);
    expect(relay.answer("s", a!.id, false)).toBe(true);
    expect(yield* Effect.forEach([first, second], result, { concurrency: 2 })).toEqual([
      false,
      true,
    ]);
    expect(relay.pending("s")).toEqual([]);
  }),
);

it.live("cancellation removes only its waiter and rejects a late approval", () =>
  Effect.gen(function* () {
    const { relay } = yield* relayFixture();
    const { controller } = yield* sdkCancellation;
    const other = yield* sdkCancellation;
    const cancelled = relay.ask("s", request, controller.signal);
    const survivor = relay.ask("s", request, other.controller.signal);
    const [a, b] = relay.pending("s");
    controller.abort();
    expect(yield* result(cancelled)).toBe(false);
    expect(relay.pending("s").map((entry) => entry.id)).toEqual([b!.id]);
    expect(relay.answer("s", a!.id, true)).toBe(false);
    expect(relay.answer("s", b!.id, true)).toBe(true);
    expect(yield* result(survivor)).toBe(true);
  }),
);

it.live("scope disposal resolves all waits as denied and prevents new waits", () =>
  Effect.gen(function* () {
    const { relay, scope } = yield* relayFixture();
    const { controller } = yield* sdkCancellation;
    const first = relay.ask("s", request, controller.signal);
    const second = relay.ask("other", request, controller.signal);
    yield* Scope.close(scope, Exit.void);
    expect(yield* Effect.forEach([first, second], result, { concurrency: 2 })).toEqual([
      false,
      false,
    ]);
    expect(relay.pending("s")).toEqual([]);
    expect(yield* result(relay.ask("s", request, controller.signal))).toBe(false);
  }),
);
