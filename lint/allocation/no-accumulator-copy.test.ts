import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { noAccumulatorCopyRule } from "./rules/no-accumulator-copy.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("no-accumulator-copy", noAccumulatorCopyRule, {
  valid: [
    // Built once, not folded.
    "const lines = items.map((item) => item.text);",
    // The fold keeps a number; the copy is of an element, not the accumulator.
    "const total = items.reduce((sum, item) => sum + item.size, 0);",
    "items.reduce((sum, item) => sum + [...item.parts].length, 0);",
    // Data-last append in a pipe is not a fold step.
    "pipe(lines, Arr.append(line));",
    // Chunk shares structure when it appends.
    "Arr.reduce(items, Chunk.empty(), (kept, item) => Chunk.append(kept, item));",
    // Appending outside any fold.
    "const next = Arr.append(lines, line);",
  ],
  invalid: [
    {
      code: "items.reduce((kept, item) => [...kept, item], []);",
      errors: [{ messageId: "copy" }],
    },
    {
      code: "Arr.reduce(items, { lines: [] }, (kept, item) => ({ lines: Arr.append(kept.lines, item) }));",
      errors: [{ messageId: "copy" }],
    },
    {
      code: "items.reduce(({ lines }, item) => ({ lines: lines.concat([item]) }), { lines: [] });",
      errors: [{ messageId: "copy" }],
    },
    {
      code: "Stream.runFoldEffect(stream, () => [], (kept, block) => Effect.as(save(block), EffectArray.append(kept, block)));",
      errors: [{ messageId: "copy" }],
    },
    {
      code: "run.reduce((state, node) => ({ ...state, segment: { texts: append(state.segment.texts, node.text) } }), start);",
      errors: [{ messageId: "copy" }],
    },
  ],
});
