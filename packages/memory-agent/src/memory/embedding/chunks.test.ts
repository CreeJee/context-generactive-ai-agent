import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { chunkPolicy, chunkText } from "./chunks.ts";

it.effect(
  "covers the entire original with bounded overlapping spans without breaking Unicode",
  () =>
    Effect.gen(function* () {
      const text = "한글🙂abc\n".repeat(1400) + "마지막 결정은 목요일";
      // Deterministic tokenizer fixture: one Unicode scalar per token, plus two special tokens.
      const count = (part: string, special: boolean) =>
        Effect.succeed(Array.from(part).length + (special ? 2 : 0));
      const spans = yield* chunkText(text, count);
      expect(spans.length).toBeGreaterThan(3);
      expect(spans[0]!.start).toBe(0);
      expect(spans.at(-1)!.end).toBe(text.length);
      for (const [index, span] of spans.entries()) {
        const part = text.slice(span.start, span.end);
        expect(new TextDecoder().decode(new TextEncoder().encode(part))).toBe(part);
        expect(yield* count(part, true)).toBeLessThanOrEqual(chunkPolicy.tokens);
        const previous = spans[index - 1];
        if (previous !== undefined) {
          expect(span.start).toBeGreaterThan(previous.start);
          expect(span.start).toBeLessThan(previous.end);
          expect(yield* count(text.slice(span.start, previous.end), false)).toBeLessThanOrEqual(
            chunkPolicy.overlap,
          );
        }
      }
      expect(text.slice(spans.at(-1)!.start)).toContain("마지막 결정은 목요일");
      expect(yield* chunkText("", count)).toEqual([]);
      expect(yield* chunkText("짧은 원문🙂", count)).toEqual([{ start: 0, end: 7 }]);
    }),
);
