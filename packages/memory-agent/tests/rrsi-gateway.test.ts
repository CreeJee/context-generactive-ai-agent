import { nativeStream } from "../src/runtime/native-stream.ts";
import { Stream } from "effect";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Queue } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { WorkerGateway, type GatewayRequest } from "../src/rrsi/worker-gateway.ts";
import { subscriptionGateway, SubscriptionResult } from "../src/rrsi/model-gateway.ts";
import { reportedTokens } from "../src/rrsi/sandbox.ts";
import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";

const request = (body: string) =>
  Effect.flatMap(WorkerGateway, (gateway) => gateway.request("request", body));
const inputFixture = Effect.acquireRelease(
  Effect.gen(function* () {
    const queue = yield* Queue.make<Uint8Array, Cause.Done>();
    return { queue, stream: Stream.fromQueue(queue) };
  }),
  (input) => Queue.end(input.queue),
);
const reply = Effect.fn("workerGateway.reply")(function* (
  input: Effect.Success<typeof inputFixture>,
  id: string,
  body: string,
) {
  const json = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        kind: Schema.Literal("response"),
        id: Schema.String,
        ok: Schema.Literal(true),
        body: Schema.String,
      }),
    ),
  )({ kind: "response", id, ok: true, body });
  yield* Queue.offer(input.queue, new TextEncoder().encode(json + "\n"));
});

it.live(
  "worker response waits correlate parallel requests by ID and tolerate reversed completion",
  () =>
    Effect.gen(function* () {
      const input = yield* inputFixture;
      const sent: GatewayRequest[] = [];
      const ready = yield* Deferred.make<void>();
      const services = yield* Layer.build(
        WorkerGateway.layer(input.stream, (frame) => {
          sent.push(frame);
          if (sent.length === 2) Deferred.doneUnsafe(ready, Effect.void);
        }),
      );
      const completed = yield* Effect.forkChild(
        Effect.provideContext(
          Effect.all([request("first"), request("second")], { concurrency: 2 }),
          services,
        ),
      );
      yield* Deferred.await(ready);
      yield* reply(input, sent[1]!.id, "two");
      yield* reply(input, sent[0]!.id, "one");
      expect(yield* Fiber.join(completed)).toEqual(["one", "two"]);
    }),
);

it.live("stdin close fails pending and future requests instead of leaving waiters parked", () =>
  Effect.gen(function* () {
    const input = yield* inputFixture;
    const ready = yield* Deferred.make<void>();
    const services = yield* Layer.build(
      WorkerGateway.layer(input.stream, () => Deferred.doneUnsafe(ready, Effect.void)),
    );
    const completed = yield* Effect.forkChild(
      Effect.provideContext(request("waiting").pipe(Effect.result), services),
    );
    yield* Deferred.await(ready);
    yield* Queue.end(input.queue);
    expect((yield* Fiber.join(completed))._tag).toBe("Failure");
    expect(
      (yield* Effect.provideContext(request("after-close").pipe(Effect.result), services))._tag,
    ).toBe("Failure");
  }),
);

it.live("cancelled request cannot settle the following request through a late reply", () =>
  Effect.gen(function* () {
    const input = yield* inputFixture;
    const sent: GatewayRequest[] = [];
    const first = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    const services = yield* Layer.build(
      WorkerGateway.layer(input.stream, (frame) => {
        sent.push(frame);
        Deferred.doneUnsafe(sent.length === 1 ? first : second, Effect.void);
      }),
    );
    const cancelled = yield* Effect.forkChild(Effect.provideContext(request("cancel"), services));
    yield* Deferred.await(first);
    yield* Fiber.interrupt(cancelled);
    expect((yield* Fiber.await(cancelled))._tag).toBe("Failure");
    const completed = yield* Effect.forkChild(Effect.provideContext(request("next"), services));
    yield* Deferred.await(second);
    yield* reply(input, sent[0]!.id, "late");
    yield* reply(input, sent[1]!.id, "current");
    expect(yield* Fiber.join(completed)).toBe("current");
  }),
);

it.live.each(["openai", "anthropic"] as const)(
  "%s gateway pins the model and preserves native reasoning and usage",
  (provider) =>
    Effect.gen(function* () {
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
          // The SDK requires an AsyncGenerator rather than an arbitrary AsyncIterable.
          stream: (body) =>
            nativeStream(
              Stream.suspend(() =>
                Stream.fromIterable(
                  (function* (): Generator<NormalizedStreamEvent> {
                    payload = body;
                    yield* events;
                  })(),
                ),
              ),
            ),
          releaseRun: () => {
            released++;
          },
        },
      );
      const gatewayScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      yield* Scope.addFinalizer(
        gatewayScope,
        Effect.sync(() => gateway.release()),
      );
      if (gateway.protocol !== "subscription") throw new Error("expected native gateway");
      const signal = yield* Effect.abortSignal;
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ model: Schema.String })),
      )({ model: "candidate-model" });
      const raw = yield* Effect.tryPromise({
        try: () => gateway.subscription(body, signal),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(
        (yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ model: Schema.String })))(
          payload,
        )).model,
      ).toBe("pinned");
      expect(
        (yield* Schema.decodeEffect(Schema.fromJsonString(SubscriptionResult))(raw)).events,
      ).toEqual(events);
      expect(reportedTokens(raw)).toBe(2000030);
      const proposalBody = yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            messages: Schema.Array(
              Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
            ),
          }),
        ),
      )({ messages: [{ role: "user", content: "Review this proposal." }] });
      const proposal = yield* Effect.tryPromise({
        try: () => gateway.complete(proposalBody, signal),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const decoded = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            choices: Schema.Array(
              Schema.Struct({ message: Schema.Struct({ content: Schema.String }) }),
            ),
          }),
        ),
      )(proposal);
      expect(decoded.choices[0]!.message.content).toBe('{"approved":true}');
      yield* Scope.close(gatewayScope, Exit.void);
      expect(released).toBe(1);
    }),
);
