import { Array as EffectArray, Effect, HashMap, Match, Option, Stream } from "effect";
import type { AiError, Response } from "effect/ai";

type Metadata = NonNullable<Response.StreamPartEncoded["metadata"]>;

interface Block {
  readonly text: string;
  readonly metadata: Metadata;
}

/** The parts finished so far, and the text and reasoning blocks still open (`text:<id>`). */
interface Collected {
  readonly output: Array<Response.PartEncoded>;
  readonly open: HashMap.HashMap<string, Block>;
}

const started = (
  state: Collected,
  { key, metadata }: { key: string; metadata: Metadata | undefined },
): Collected => ({
  ...state,
  open: HashMap.set(state.open, key, { text: "", metadata: metadata ?? {} }),
});

const appended = (state: Collected, { key, delta }: { key: string; delta: string }): Collected => ({
  ...state,
  open: HashMap.modify(state.open, key, (block) => ({ ...block, text: block.text + delta })),
});

/** A block's text, with its start and end metadata merged. */
const merged = (block: Block, metadata: Metadata | undefined) => ({
  text: block.text,
  metadata: { ...block.metadata, ...metadata },
});

/** Closes a block as the part `finished` makes of it. */
const ended = (
  state: Collected,
  {
    key,
    metadata,
    finished,
  }: {
    key: string;
    metadata: Metadata | undefined;
    finished: (block: ReturnType<typeof merged>) => Response.PartEncoded;
  },
): Collected => ({
  open: HashMap.remove(state.open, key),
  output: [
    ...state.output,
    finished(
      merged(
        Option.getOrElse(HashMap.get(state.open, key), () => ({ text: "", metadata: {} })),
        metadata,
      ),
    ),
  ],
});

const collected = (state: Collected, part: Response.StreamPartEncoded): Collected =>
  Match.value(part).pipe(
    Match.discriminators("type")({
      "text-start": ({ id, metadata }) => started(state, { key: `text:${id}`, metadata }),
      "reasoning-start": ({ id, metadata }) => started(state, { key: `reasoning:${id}`, metadata }),
      "text-delta": ({ id, delta }) => appended(state, { key: `text:${id}`, delta }),
      "reasoning-delta": ({ id, delta }) => appended(state, { key: `reasoning:${id}`, delta }),
      "text-end": ({ id, metadata }) =>
        ended(state, {
          key: `text:${id}`,
          metadata,
          finished: (block) => ({ type: "text", ...block }),
        }),
      "reasoning-end": ({ id, metadata }) =>
        ended(state, {
          key: `reasoning:${id}`,
          metadata,
          finished: (block) => ({ type: "reasoning", ...block }),
        }),
      "tool-params-start": () => state,
      "tool-params-delta": () => state,
      "tool-params-end": () => state,
      error: () => state,
    }),
    Match.orElse((whole) => ({ ...state, output: [...state.output, whole] })),
  );

/**
 * The whole response a part stream describes, for `generateText` of a model that only streams:
 * text and reasoning blocks become one part each, with their start and end metadata merged.
 */
export const collectResponse = <R>(
  stream: Stream.Stream<Response.StreamPartEncoded, AiError.AiError, R>,
): Effect.Effect<Array<Response.PartEncoded>, AiError.AiError, R> =>
  Effect.map(
    Stream.runCollect(stream),
    (parts) => EffectArray.reduce(parts, { output: [], open: HashMap.empty() }, collected).output,
  );
