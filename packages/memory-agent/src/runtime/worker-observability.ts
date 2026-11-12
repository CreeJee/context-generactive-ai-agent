import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";
import { workerFailedSpansLayer } from "./failed-spans.ts";

/**
 * A worker thread's spans over OTLP/JSON, from the `OTEL_*` variables it inherits from the owner
 * process: nothing is exported unless the owner's are set. Worker spans carry the owner's trace id
 * (Effect RPC sends the parent), so the collector shows them under the request that caused them.
 */
const otlp = OtlpTracer.layerFromConfig({ resource: { serviceName: "context-agent" } }).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer),
);

/**
 * What every worker entry provides to its whole program: the failed-span recorder that sends to
 * the owner, wrapping the OTLP exporter so both see each span.
 */
export const workerObservabilityLayer = workerFailedSpansLayer.pipe(Layer.provideMerge(otlp));
