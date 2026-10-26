import { Effect, Stream } from "effect";
import type { AiError, Response } from "effect/ai";

type Metadata = NonNullable<Response.StreamPartEncoded["metadata"]>;

/**
 * The whole response a part stream describes, for `generateText` of a model that only streams:
 * text and reasoning blocks become one part each, with their start and end metadata merged.
 */
export const collectResponse = <R>(
  stream: Stream.Stream<Response.StreamPartEncoded, AiError.AiError, R>,
): Effect.Effect<Array<Response.PartEncoded>, AiError.AiError, R> =>
  Effect.map(Stream.runCollect(stream), (parts) => {
    const output: Array<Response.PartEncoded> = [];
    const open = new Map<string, { text: string; metadata: Metadata }>();
    const start = (id: string, metadata: Metadata | undefined) =>
      open.set(id, { text: "", metadata: metadata ?? {} });
    const append = (id: string, delta: string) => {
      const block = open.get(id);
      if (block !== undefined) block.text += delta;
    };
    const end = (id: string, metadata: Metadata | undefined) => {
      const block = open.get(id) ?? { text: "", metadata: {} };
      open.delete(id);
      return { text: block.text, metadata: { ...block.metadata, ...metadata } };
    };
    for (const part of parts)
      switch (part.type) {
        case "text-start":
        case "reasoning-start":
          start(`${part.type}:${part.id}`, part.metadata);
          break;
        case "text-delta":
          append(`text-start:${part.id}`, part.delta);
          break;
        case "reasoning-delta":
          append(`reasoning-start:${part.id}`, part.delta);
          break;
        case "text-end":
          output.push({ type: "text", ...end(`text-start:${part.id}`, part.metadata) });
          break;
        case "reasoning-end":
          output.push({ type: "reasoning", ...end(`reasoning-start:${part.id}`, part.metadata) });
          break;
        case "tool-params-start":
        case "tool-params-delta":
        case "tool-params-end":
        case "error":
          break;
        default:
          output.push(part);
      }
    return output;
  });
