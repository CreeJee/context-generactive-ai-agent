import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Console, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { nanosToMillis, scalarAttributes, SpanWriter, type SpanRecord } from "./span-record.ts";

// Excess keys are dropped while decoding, so string attribute values never reach the file.
const OtlpValue = Schema.Struct({
  boolValue: Schema.optionalKey(Schema.Boolean),
  intValue: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.FiniteFromString])),
  doubleValue: Schema.optionalKey(Schema.Finite),
});

const OtlpSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optionalKey(Schema.String),
  name: Schema.String,
  startTimeUnixNano: Schema.BigIntFromString,
  endTimeUnixNano: Schema.BigIntFromString,
  attributes: Schema.Array(Schema.Struct({ key: Schema.String, value: OtlpValue })),
  status: Schema.Struct({ code: Schema.Finite }),
});

const OtlpTraces = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({ scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(OtlpSpan) })) }),
  ),
});

const otlpStatusError = 2;

const toRecord = (span: typeof OtlpSpan.Type): SpanRecord => {
  const attributes = scalarAttributes(
    span.attributes.map(({ key, value }) => [
      key,
      value.boolValue ?? value.intValue ?? value.doubleValue,
    ]),
  );
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId:
      span.parentSpanId === undefined || span.parentSpanId === "" ? null : span.parentSpanId,
    name: span.name,
    startUnixMs: nanosToMillis(span.startTimeUnixNano),
    durationMs: nanosToMillis(span.endTimeUnixNano - span.startTimeUnixNano),
    // Effect marks interrupted spans with Unset status plus this attribute.
    outcome:
      span.status.code === otlpStatusError
        ? "error"
        : attributes["effect.fiber.interrupted"] === true
          ? "interrupted"
          : "ok",
    attributes,
  };
};

/** Receives OTLP/JSON traces on `/v1/traces` for the span writer; metrics are accepted and dropped. */
export const otlpCollector = (port: number) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { file, write } = yield* SpanWriter;
      const traces = HttpRouter.add(
        "POST",
        "/v1/traces",
        HttpServerRequest.schemaBodyJson(OtlpTraces).pipe(
          Effect.flatMap((body) =>
            write(
              body.resourceSpans.flatMap((resource) =>
                resource.scopeSpans.flatMap((scope) => scope.spans.map(toRecord)),
              ),
            ),
          ),
          Effect.as(HttpServerResponse.empty({ status: 200 })),
          Effect.catchTag(["SchemaError", "HttpServerError"], () =>
            Effect.succeed(HttpServerResponse.empty({ status: 400 })),
          ),
        ),
      );
      const metrics = HttpRouter.add(
        "POST",
        "/v1/metrics",
        HttpServerResponse.empty({ status: 200 }),
      );
      yield* Console.log(`OTLP 수집 중: http://127.0.0.1:${port} -> ${file}`);
      return HttpRouter.serve(Layer.mergeAll(traces, metrics), { disableLogger: true });
    }),
  ).pipe(
    // Loopback only: spans are local profiling data, not a network service.
    Layer.provide(NodeHttpServer.layer(NodeHttpServer.createServer, { port, host: "127.0.0.1" })),
    Layer.launch,
  );
