import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { Cause, Console, Effect, Exit, Option, Stream } from "effect";
import { DevToolsSchema, DevToolsServer } from "effect/devtools";
import { nanosToMillis, scalarAttributes, SpanWriter, type SpanRecord } from "./span-record.ts";

const outcomeOf = (exit: DevToolsSchema.SpanStatusEnded["exit"]): SpanRecord["outcome"] =>
  Exit.isSuccess(exit) ? "ok" : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "error";

/** Devtools sends each span when it starts and again when it ends; only the ended copy is kept. */
const toRecord = (request: DevToolsSchema.Request.WithoutPing): ReadonlyArray<SpanRecord> => {
  switch (request._tag) {
    case "Span": {
      const { status } = request;
      switch (status._tag) {
        case "Started":
          return [];
        case "Ended":
          return [
            {
              traceId: request.traceId,
              spanId: request.spanId,
              parentSpanId: Option.getOrNull(Option.map(request.parent, (parent) => parent.spanId)),
              name: request.name,
              startUnixMs: nanosToMillis(status.startTime),
              durationMs: nanosToMillis(status.endTime - status.startTime),
              outcome: outcomeOf(status.exit),
              attributes: scalarAttributes(request.attributes),
            },
          ];
      }
    }
    case "SpanEvent":
    case "MetricsSnapshot":
      return [];
  }
};

/** Effect devtools socket server for development: hands every ended span to the span writer. */
export const devtoolsCollector = (port: number) =>
  Effect.gen(function* () {
    const { file, write } = yield* SpanWriter;
    yield* Console.log(`devtools 수집 중: ws://127.0.0.1:${port} -> ${file}`);
    return yield* DevToolsServer.run((client) =>
      Stream.fromQueue(client.queue).pipe(Stream.runForEach((request) => write(toRecord(request)))),
    );
  }).pipe(Effect.provide(NodeSocketServer.layerWebSocket({ port })));
