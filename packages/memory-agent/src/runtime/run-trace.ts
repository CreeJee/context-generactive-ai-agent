import { Context, Effect, Function as EffectFunction, Tracer } from "effect";

/** A run's context. It carries the run's span, so tool calls made for the run join its trace. */
export type RunTrace = Context.Context<Tracer.ParentSpan>;

/**
 * The calling run's context. It needs a span, so tools built for a run are built inside it; read
 * it before a factory's own `Effect.fn` span starts, or the tools nest under that span instead.
 */
export const runTrace: Effect.Effect<RunTrace, never, Tracer.ParentSpan> =
  Effect.context<Tracer.ParentSpan>();

/** Tool services on top of the run's context: the layer's services win, the run adds its span. */
export const onRun: {
  (caller: RunTrace): <R>(services: Context.Context<R>) => Context.Context<R | Tracer.ParentSpan>;
} & typeof onRunBody = EffectFunction.dual(2, onRunBody);
function onRunBody<R>(services: Context.Context<R>, caller: RunTrace) {
  return Context.merge(caller, services);
}
