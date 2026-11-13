import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { rankSkills } from "./skill-search.ts";
import type { Skill } from "./skills.ts";

const skill = (name: string, description: string): Skill => ({
  scope: "project",
  name,
  description,
  directory: "",
  contentHash: name,
});

const catalog = [
  skill("vp-fmt", "Format the files of the repository."),
  skill("vp-check", "Run the lint and the format check of the repository."),
  skill("agent-test", "Run the tests of the agent package."),
  skill("테스트-실행", "패키지의 테스트를 실행한다."),
];

const ranked = (
  query: string,
  vectors: Record<string, Float32Array> = {},
  queryVector?: number[],
) =>
  rankSkills({
    catalog,
    query,
    queryVector: Option.map(Option.fromNullishOr(queryVector), (v) => Float32Array.from(v)),
    vectorOf: (found) => Option.fromNullishOr(vectors[found.name]),
    limit: 3,
  }).map((found) => found.name);

describe("rankSkills", () => {
  it("weighs a word by how few skills have it, so common words decide nothing", () => {
    expect(ranked("run the tests")[0]).toBe("agent-test");
    expect(ranked("the")).toEqual(["vp-fmt", "vp-check", "agent-test"]);
  });

  it("finds a skill's word with a Korean particle or an English ending on it", () => {
    expect(ranked("테스트를 돌려줘")).toEqual(["테스트-실행"]);
    expect(ranked("formats")[0]).toBe("vp-fmt");
  });

  it("ranks by meaning the skills that share no word with the query", () => {
    const vectors = {
      "vp-fmt": Float32Array.from([1, 0]),
      "vp-check": Float32Array.from([0.6, 0.8]),
      "agent-test": Float32Array.from([0, 1]),
    };
    expect(ranked("정리", vectors, [1, 0])).toEqual(["vp-fmt", "vp-check", "agent-test"]);
    expect(ranked("정리")).toEqual([]);
  });
});
