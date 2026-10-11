import { MutableHashMap } from "effect";
import { expect, test } from "vite-plus/test";
import { parseFrontMatter } from "./skills.ts";

test("parseFrontMatter reads plain, quoted and folded values and returns the body", () => {
  const { fields, body } = parseFrontMatter(
    '---\nname: "review"\ndescription: >\n  Review a change\n  line by line.\nnotes: |\n  a\n  b\nlicense: MIT\n---\n# Body\n',
  );
  expect(Object.fromEntries(fields)).toEqual({
    name: "review",
    description: "Review a change line by line.",
    notes: "a\nb",
    license: "MIT",
  });
  expect(body).toBe("# Body\n");
  expect(MutableHashMap.size(parseFrontMatter("no front matter").fields)).toBe(0);
});
