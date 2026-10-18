import { Config, Effect, Layer, Option } from "effect";
import { DevTools } from "effect/devtools";
import { FetchHttpClient } from "effect/http";
import { OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability";

const resource = { serviceName: "context-agent" };

/**
 * Spans and metrics over OTLP/JSON, opted into with the standard `OTEL_*` variables: nothing is
 * exported unless `OTEL_TRACES_EXPORTER`/`OTEL_METRICS_EXPORTER` include `otlp` and an endpoint is
 * set. Logs are not exported; they can carry prompts and provider responses.
 */
const otlp = Layer.mergeAll(
  OtlpTracer.layerFromConfig({ resource }),
  OtlpMetrics.layerFromConfig({ resource }),
).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));

/**
 * Development only: `CONTEXT_AGENT_DEVTOOLS_URL` also streams spans to an Effect devtools server.
 * Its tracer wraps the OTLP one below, so both receive every span.
 */
const devtools = Layer.unwrap(
  Config.option(Config.String("CONTEXT_AGENT_DEVTOOLS_URL")).pipe(
    Effect.map(Option.match({ onNone: () => Layer.empty, onSome: DevTools.layer })),
  ),
);

export const observabilityLayer = devtools.pipe(Layer.provideMerge(otlp));
