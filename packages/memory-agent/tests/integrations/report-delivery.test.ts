import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { SecretStore } from "../../src/config/secrets.ts";
import { ReportDelivery, parseWebhookUrl } from "../../src/report/discord-webhook.ts";
import { HttpServerRequest, HttpServerResponse, testHttpServer } from "../support/http.ts";

interface Reply {
  readonly status: number;
  readonly body: string;
}

const token = "tok_abcdefghijklmnopqrstuvwxyz0123";
const message = (id: string): Reply => ({ status: 200, body: `{"id":"${id}"}` });

/** A local stand-in for Discord's execute-webhook route; nothing leaves the machine. */
const fakeDiscord = Effect.fnUntraced(function* (replies: readonly Reply[]) {
  const queue = yield* Ref.make(replies);
  const received = yield* Ref.make<readonly { url: string; body: string }[]>([]);
  const arrived = yield* Deferred.make<void>();
  const release = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const { url } = yield* testHttpServer(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.text;
      yield* Ref.update(received, (all) => [...all, { url: request.url, body }]);
      yield* Deferred.succeed(arrived, undefined);
      const gate = yield* Ref.get(release);
      if (gate !== null) yield* Deferred.await(gate);
      const reply = yield* Ref.modify(queue, ([next, ...rest]) => [next ?? message("x"), rest]);
      return HttpServerResponse.text(reply.body, {
        status: reply.status,
        contentType: "application/json",
      });
    }),
  );
  const services = yield* Layer.build(
    ReportDelivery.layer({ allowLoopback: true }).pipe(Layer.provide(SecretStore.memory)),
  );
  const delivery = yield* Effect.provideContext(ReportDelivery, services);
  yield* delivery.configure(`${url}/api/webhooks/123456789012345678/${token}`);
  return { delivery, received, arrived, release };
});

describe("report delivery to a Discord webhook", () => {
  it("accepts only execute-webhook URLs on Discord outside tests", () => {
    const valid = `https://discord.com/api/webhooks/123456789012345678/${token}`;
    expect(parseWebhookUrl(valid, false)?.id).toBe("123456789012345678");
    expect(parseWebhookUrl(valid.replace("https:", "http:"), false)).toBeNull();
    expect(parseWebhookUrl(valid.replace("discord.com", "example.com"), false)).toBeNull();
    expect(
      parseWebhookUrl(`http://127.0.0.1:1/api/webhooks/123456789012345678/${token}`, false),
    ).toBeNull();
  });

  it.live("posts the reviewed text without mentions, then recognises the same text", () =>
    Effect.gen(function* () {
      const { delivery, received } = yield* fakeDiscord([message("m1"), message("m2")]);
      const sent = yield* delivery.send("# 제보\n@everyone 승인 반복", false);
      expect(sent).toMatchObject({ status: "delivered", messageId: "m1" });
      const [request] = yield* Ref.get(received);
      expect(request?.url).toContain("wait=true");
      expect(request?.body).toContain('"allowed_mentions":{"parse":[]}');
      expect(request?.body).toContain('filename="context-agent-report.txt"');

      expect(yield* delivery.send("# 제보\n@everyone 승인 반복", false)).toMatchObject({
        status: "duplicate",
      });
      expect(yield* Ref.get(received)).toHaveLength(1);
      expect(yield* delivery.send("# 제보\n@everyone 승인 반복", true)).toMatchObject({
        status: "delivered",
        messageId: "m2",
      });
    }),
  );

  it.live("waits out a short rate limit, and stops on a rejected webhook", () =>
    Effect.gen(function* () {
      const { delivery, received } = yield* fakeDiscord([
        { status: 429, body: '{"retry_after":0.01,"global":false}' },
        message("m1"),
        { status: 404, body: '{"message":"Unknown Webhook"}' },
      ]);
      expect(yield* delivery.send("a", false)).toMatchObject({ status: "delivered" });
      expect(yield* Ref.get(received)).toHaveLength(2);

      const failure = yield* Effect.flip(delivery.send("b", false));
      expect(failure).toMatchObject({ reason: "webhook_rejected", httpStatus: 404 });
    }),
  );

  it.live("an unconfirmed send is not repeated silently, and a parallel send is refused", () =>
    Effect.gen(function* () {
      const { delivery, arrived, release } = yield* fakeDiscord([
        { status: 200, body: "not json" },
      ]);
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(release, gate);
      const first = yield* Effect.forkChild(Effect.flip(delivery.send("c", false)));
      yield* Deferred.await(arrived);
      expect(yield* Effect.flip(delivery.send("c", false))).toMatchObject({
        reason: "in_progress",
      });
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(first)).toMatchObject({ reason: "uncertain" });
      expect(yield* delivery.send("c", false)).toMatchObject({ status: "uncertain_duplicate" });
    }),
  );
});
