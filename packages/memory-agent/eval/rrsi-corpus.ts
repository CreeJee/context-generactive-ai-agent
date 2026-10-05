export type EvalSplit = "evolve" | "validation" | "sealed";
export interface EvalTask {
  id: string;
  domain: "coding" | "memory";
  turns: readonly string[];
  fixture: string;
  expected: string;
  verification: string;
}
// Verifiers stay outside proposer feedback. Each suite has distinct inputs; sealed coding uses new families.
export function corpus(split: EvalSplit): EvalTask[] {
  const offset = split === "evolve" ? 10 : split === "validation" ? 100 : 1000;
  const specs =
    split === "sealed"
      ? [
          {
            fixture: "export const solve = (a,b) => a-b;\n",
            task: "Return the product of a and b.",
            verification: `solve(${offset},${offset + 1})`,
            expected: String(offset * (offset + 1)),
          },
          {
            fixture: "export const solve = (text) => text;\n",
            task: "Trim whitespace and lowercase the input text.",
            verification: 'solve("  HeLLo  ")',
            expected: "hello",
          },
          {
            fixture: "export const solve = (rows) => rows;\n",
            task: "Return a copy of rows sorted ascending by their numeric score. Do not mutate the input.",
            verification: "JSON.stringify(solve([{score:3},{score:1}]))",
            expected: '[{"score":1},{"score":3}]',
          },
        ]
      : [
          {
            fixture: "export const solve = (values) => values.reduce((sum,value)=>sum-value,0);\n",
            task: "Return the sum of all input values, including an empty array.",
            verification: `solve([${offset},${offset + 1}])`,
            expected: String(offset * 2 + 1),
          },
          {
            fixture: "export const solve = (values) => values.length;\n",
            task: "Return the average of input numbers; return 0 for an empty array.",
            verification: `JSON.stringify([solve([${offset},${offset + 2}]),solve([])])`,
            expected: `[${offset + 1},0]`,
          },
          {
            fixture: "export const solve = (values) => values;\n",
            task: "Return distinct values, preserving first-occurrence order.",
            verification: `JSON.stringify(solve([${offset},1,${offset},1,2]))`,
            expected: `[${offset},1,2]`,
          },
          {
            fixture: "export const solve = (values) => values;\n",
            task: "Return a reversed copy of the array without mutating it.",
            verification: "JSON.stringify(solve([1,2,3]))",
            expected: "[3,2,1]",
          },
          {
            fixture: "export const solve = (n) => n;\n",
            task: "Return n factorial for a nonnegative integer, including 0 factorial = 1.",
            verification: "JSON.stringify([solve(5),solve(0)])",
            expected: "[120,1]",
          },
          {
            fixture: "export const solve = (value,low,high) => value;\n",
            task: "Clamp a number to the inclusive low/high interval.",
            verification: "JSON.stringify([solve(-1,0,10),solve(15,0,10),solve(5,0,10)])",
            expected: "[0,10,5]",
          },
        ].slice(0, split === "validation" ? 3 : 6);
  return specs.flatMap((spec, index) => {
    const phrase = `decision-${offset + index}-violet`;
    return [
      {
        id: `${split}-coding-${index}`,
        domain: "coding" as const,
        fixture: spec.fixture,
        turns: [
          `Read src/solve.mjs and repair its exported solve function: ${spec.task} Write the change and verify it with node.`,
        ],
        verification: spec.verification,
        expected: spec.expected,
      },
      {
        id: `${split}-memory-${index}`,
        domain: "memory" as const,
        fixture: "",
        verification: "",
        turns: [
          `Remember this exact user decision: obsolete-${offset + index}.`,
          `Correction: replace my previous decision with ${phrase}.`,
          "Read notes.txt and describe its topic in one short sentence.",
          "What is my current decision? Retrieve original evidence if necessary. Give the exact phrase and cite its node ID.",
        ],
        expected: phrase,
      },
    ];
  });
}
