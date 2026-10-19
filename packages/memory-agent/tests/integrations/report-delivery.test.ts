import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Ref } from "effect";
import {
  ReportDelivery,
  parseWebhookUrl,
  webhookConfigKey,
} from "../../src/report/discord-webhook.ts";
import { HttpServerRequest, HttpServerResponse, testHttpServer } from "../support/http.ts";

interface Reply {
  readonly status: number;
  readonly body: string;
}

const token = "tok_abcdefghijklmnopqrstuvwxyz0123";
const message = (id: string): Reply => ({ status: 200, body: `{"id":"${id}"}` });
const report = (text: string) => ({ text, evidence: null });

/** Builds the service with `DISCORD_WEBHOOK_URL` set (or not) in server configuration. */
const deliveryWith = (config: Record<string, string>) =>
  Layer.build(
    ReportDelivery.layer({ allowLoopback: true }).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
    ),
  ).pipe(Effect.flatMap((services) => Effect.provideContext(ReportDelivery, services)));

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
  const delivery = yield* deliveryWith({
    [webhookConfigKey]: `${url}/api/webhooks/123456789012345678/${token}`,
  });
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

  it.effect("reads the webhook only from server configuration and never exposes it", () =>
    Effect.gen(function* () {
      const missing = yield* deliveryWith({});
      expect(yield* missing.status).toEqual({ configured: false, webhookIdSuffix: null });
      expect(yield* Effect.flip(missing.send(report("a"), false))).toMatchObject({
        reason: "not_configured",
      });
      const invalid = yield* deliveryWith({ [webhookConfigKey]: "https://example.com/hook" });
      expect(yield* Effect.flip(invalid.send(report("a"), false))).toMatchObject({
        reason: "invalid_webhook_url",
      });
      const configured = yield* deliveryWith({
        [webhookConfigKey]: `https://discord.com/api/webhooks/123456789012345678/${token}`,
      });
      expect(yield* configured.status).toEqual({ configured: true, webhookIdSuffix: "5678" });
    }).pipe(Effect.scoped),
  );

  it.live("posts the draft and the evidence bundle without mentions, then recognises them", () =>
    Effect.gen(function* () {
      const { delivery, received } = yield* fakeDiscord([
        message("m1"),
        message("m2"),
        message("m3"),
      ]);
      const reviewed = { text: "# 제보\n@everyone 승인 반복", evidence: '{"version":1}' };
      const sent = yield* delivery.send(reviewed, false);
      expect(sent).toMatchObject({ status: "delivered", messageId: "m1" });
      const [request] = yield* Ref.get(received);
      expect(request?.url).toContain("wait=true");
      expect(request?.body).toContain('"allowed_mentions":{"parse":[]}');
      expect(request?.body).toContain('filename="context-agent-report.txt"');
      expect(request?.body).toContain('filename="context-agent-evidence.json"');
      expect(request?.body).toContain('{"version":1}');

      expect(yield* delivery.send(reviewed, false)).toMatchObject({ status: "duplicate" });
      expect(yield* Ref.get(received)).toHaveLength(1);
      // The same draft with other evidence is a different report.
      expect(yield* delivery.send({ ...reviewed, evidence: null }, false)).toMatchObject({
        status: "delivered",
        messageId: "m2",
      });
      expect(yield* delivery.send(reviewed, true)).toMatchObject({
        status: "delivered",
        messageId: "m3",
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
      expect(yield* delivery.send(report("a"), false)).toMatchObject({ status: "delivered" });
      expect(yield* Ref.get(received)).toHaveLength(2);

      const failure = yield* Effect.flip(delivery.send(report("b"), false));
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
      const first = yield* Effect.forkChild(Effect.flip(delivery.send(report("c"), false)));
      yield* Deferred.await(arrived);
      expect(yield* Effect.flip(delivery.send(report("c"), false))).toMatchObject({
        reason: "in_progress",
      });
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(first)).toMatchObject({ reason: "uncertain" });
      expect(yield* delivery.send(report("c"), false)).toMatchObject({
        status: "uncertain_duplicate",
      });
    }),
  );
});
