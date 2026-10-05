import { PassThrough } from "node:stream";
import { Deferred, Effect, ManagedRuntime } from "effect";
import { expect, test } from "vite-plus/test";
import { WorkerGateway, type GatewayRequest } from "../src/rrsi/worker-gateway.ts";
import { subscriptionGateway } from "../src/rrsi/model-gateway.ts";
import { reportedTokens } from "../src/rrsi/sandbox.ts";
import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";

const request = (body: string) =>
  Effect.flatMap(WorkerGateway, (gateway) => gateway.request("request", body));

test("worker response waits correlate parallel requests by ID and tolerate reversed completion", async () => {
  const input = new PassThrough();
  const sent: GatewayRequest[] = [];
  const ready = Deferred.makeUnsafe<void>();
  const runtime = ManagedRuntime.make(
    WorkerGateway.layer(input, (frame) => {
      sent.push(frame);
      if (sent.length === 2) Deferred.doneUnsafe(ready, Effect.void);
    }),
  );
  try {
    const completed = runtime.runPromise(
      Effect.all([request("first"), request("second")], { concurrency: 2 }),
    );
    await Effect.runPromise(Deferred.await(ready));
    input.write(
      JSON.stringify({ kind: "response", id: sent[1]!.id, ok: true, body: "two" }) + "\n",
    );
    input.write(
      JSON.stringify({ kind: "response", id: sent[0]!.id, ok: true, body: "one" }) + "\n",
    );
    expect(await completed).toEqual(["one", "two"]);
  } finally {
    await runtime.dispose();
    input.destroy();
  }
});

test("stdin close fails pending and future requests instead of leaving waiters parked", async () => {
  const input = new PassThrough();
  const ready = Deferred.makeUnsafe<void>();
  const runtime = ManagedRuntime.make(
    WorkerGateway.layer(input, () => Deferred.doneUnsafe(ready, Effect.void)),
  );
  try {
    const completed = runtime.runPromise(request("waiting").pipe(Effect.result));
    await Effect.runPromise(Deferred.await(ready));
    input.end();
    expect((await completed)._tag).toBe("Failure");
    expect((await runtime.runPromise(request("after-close").pipe(Effect.result)))._tag).toBe(
      "Failure",
    );
  } finally {
    await runtime.dispose();
    input.destroy();
  }
});

test("cancelled request cannot settle the following request through a late reply", async () => {
  const input = new PassThrough();
  const sent: GatewayRequest[] = [];
  const first = Deferred.makeUnsafe<void>();
  const second = Deferred.makeUnsafe<void>();
  const runtime = ManagedRuntime.make(
    WorkerGateway.layer(input, (frame) => {
      sent.push(frame);
      Deferred.doneUnsafe(sent.length === 1 ? first : second, Effect.void);
    }),
  );
  try {
    const abort = new AbortController();
    const cancelled = runtime.runPromise(request("cancel"), { signal: abort.signal }).then(
      () => false,
      () => true,
    );
    await Effect.runPromise(Deferred.await(first));
    abort.abort();
    expect(await cancelled).toBe(true);
    const completed = runtime.runPromise(request("next"));
    await Effect.runPromise(Deferred.await(second));
    input.write(
      JSON.stringify({ kind: "response", id: sent[0]!.id, ok: true, body: "late" }) + "\n",
    );
    input.write(
      JSON.stringify({ kind: "response", id: sent[1]!.id, ok: true, body: "current" }) + "\n",
    );
    expect(await completed).toBe("current");
  } finally {
    await runtime.dispose();
    input.destroy();
  }
});

test.each(["openai", "anthropic"] as const)(
  "%s gateway pins the model and preserves native reasoning and usage",
  async (provider) => {
    let payload = "";
    let released = 0;
    const events: NormalizedStreamEvent[] = [
      { type: "reasoning", id: "reason", encryptedContent: "opaque-signature" },
      { type: "text", text: '{"approved":true}' },
      { type: "tool-call", id: "call", name: "lookup", arguments: { query: "evidence" } },
      { type: "usage", promptTokens: 2000000, completionTokens: 30, cachedPromptTokens: 10 },
    ];
    const gateway = subscriptionGateway(
      { provider, model: "pinned", reasoningEffort: "low" },
      {
        async *stream(body) {
          payload = body;
          yield* events;
        },
        releaseRun: () => {
          released++;
        },
      },
    );
    if (gateway.protocol !== "subscription") throw new Error("expected native gateway");
    const raw = await gateway.subscription(
      JSON.stringify({ model: "candidate-model" }),
      new AbortController().signal,
    );
    expect(JSON.parse(payload).model).toBe("pinned");
    expect(JSON.parse(raw).events).toEqual(events);
    expect(reportedTokens(raw)).toBe(2000030);
    const proposal = await gateway.complete(
      JSON.stringify({ messages: [{ role: "user", content: "Review this proposal." }] }),
      new AbortController().signal,
    );
    expect(JSON.parse(proposal).choices[0].message.content).toBe('{"approved":true}');
    gateway.release();
    expect(released).toBe(1);
  },
);
