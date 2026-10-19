import { Context, Effect, Tracer } from "effect";

/** A run's context. It carries the run's span, so tool calls made for the run join its trace. */
export type RunTrace = Context.Context<Tracer.ParentSpan>;

/** The calling run's context; it exists only inside a span. */
export const runTrace: Effect.Effect<RunTrace, never, Tracer.ParentSpan> =
  Effect.context<Tracer.ParentSpan>();

/** Tool services on top of the run's context; without a run (tests) the services alone. */
export const onRun = <R>(services: Context.Context<R>, caller: RunTrace | undefined) =>
  caller === undefined ? services : Context.merge(caller, services);
