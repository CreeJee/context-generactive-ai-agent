import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

type Split = "train" | "validation" | "holdout";
const Evidence = Schema.Struct({ id: Schema.String, project: Schema.String, text: Schema.String });
const Case = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  priorEvidence: Schema.Array(Evidence),
  recentTurns: Schema.Array(Schema.String),
  searchEvidenceIds: Schema.Array(Schema.String),
  recallNeeded: Schema.Boolean,
  goldEvidenceIds: Schema.Array(Schema.String),
  expected: Schema.Struct({
    handling: Schema.Union([
      Schema.Literal("current"),
      Schema.Literal("supersession"),
      Schema.Literal("project_boundary"),
      Schema.Literal("not_needed"),
      Schema.Literal("unresolved_empty_search"),
    ]),
    currentEvidenceIds: Schema.Array(Schema.String),
    supersededEvidenceIds: Schema.Array(Schema.String),
  }),
});
const Fixture = Schema.Struct({
  schemaVersion: Schema.Number,
  description: Schema.String,
  partitions: Schema.Struct({
    train: Schema.Array(Schema.String),
    validation: Schema.Array(Schema.String),
    holdout: Schema.Array(Schema.String),
  }),
  cases: Schema.Array(Case),
});

const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(Fixture))(
  readFileSync(new URL("../eval/recall-turns.fixture.json", import.meta.url), "utf8"),
);
const splits: Split[] = ["train", "validation", "holdout"];
const prefix: Record<Split, string> = { train: "tr", validation: "va", holdout: "ho" };
const handlings = [
  "current",
  "supersession",
  "project_boundary",
  "not_needed",
  "unresolved_empty_search",
];
const unique = (values: readonly string[]) => new Set(values).size === values.length;

test("synthetic recall turns have deterministic disjoint splits and grounded gold evidence", () => {
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.description).toContain("Synthetic");
  expect(Object.keys(fixture.partitions)).toEqual(splits);
  const caseIds = fixture.cases.map((item) => item.id);
  expect(unique(caseIds)).toBe(true);
  expect(splits.flatMap((split) => fixture.partitions[split])).toEqual(caseIds);
  expect(splits.every((split) => fixture.partitions[split].length > 0)).toBe(true);

  const evidenceBySplit = new Map<Split, Set<string>>();
  for (const split of splits) {
    const evidenceIds: string[] = [];
    for (const id of fixture.partitions[split]) {
      const item = fixture.cases.find((candidate) => candidate.id === id);
      expect(item, id).toBeDefined();
      if (!item) continue;
      expect(item.id.startsWith(`${prefix[split]}-`), id).toBe(true);
      expect(item.project).toMatch(/^synthetic-/);
      expect(handlings).toContain(item.expected.handling);
      expect(item.recentTurns.length).toBeGreaterThan(0);
      expect(item.recentTurns.every((turn) => turn.length > 0)).toBe(true);
      const localIds = item.priorEvidence.map((evidence) => evidence.id);
      expect(unique(localIds), id).toBe(true);
      for (const evidence of item.priorEvidence) {
        expect(evidence.id).toMatch(/^ev-(tr|va|ho)-/);
        expect(evidence.project).toMatch(/^synthetic-/);
        expect(evidence.text.length).toBeGreaterThan(0);
      }
      for (const ids of [
        item.searchEvidenceIds,
        item.goldEvidenceIds,
        item.expected.currentEvidenceIds,
        item.expected.supersededEvidenceIds,
      ]) {
        expect(Array.isArray(ids), id).toBe(true);
        expect(unique(ids), id).toBe(true);
        expect(
          ids.every((evidenceId) => localIds.includes(evidenceId)),
          id,
        ).toBe(true);
      }
      expect(
        item.goldEvidenceIds.every((evidenceId) => item.searchEvidenceIds.includes(evidenceId)),
        id,
      ).toBe(true);
      expect(
        [...item.expected.currentEvidenceIds, ...item.expected.supersededEvidenceIds].sort(),
      ).toEqual([...item.goldEvidenceIds].sort());
      expect(
        item.expected.currentEvidenceIds.every(
          (evidenceId) =>
            item.priorEvidence.find((evidence) => evidence.id === evidenceId)?.project ===
            item.project,
        ),
        id,
      ).toBe(true);
      if (!item.recallNeeded) {
        expect(item.expected.handling).toBe("not_needed");
        expect(item.searchEvidenceIds).toEqual([]);
        expect(item.goldEvidenceIds).toEqual([]);
      } else if (item.expected.handling === "unresolved_empty_search") {
        expect(item.searchEvidenceIds).toEqual([]);
        expect(item.goldEvidenceIds).toEqual([]);
      } else {
        expect(item.goldEvidenceIds.length).toBeGreaterThan(0);
        expect(item.expected.currentEvidenceIds.length).toBeGreaterThan(0);
      }
      if (item.expected.handling === "supersession") {
        expect(item.expected.supersededEvidenceIds.length).toBeGreaterThan(0);
      } else {
        expect(item.expected.supersededEvidenceIds).toEqual([]);
      }
      evidenceIds.push(...localIds);
    }
    expect(unique(evidenceIds), split).toBe(true);
    evidenceBySplit.set(split, new Set(evidenceIds));
  }
  for (const left of splits)
    for (const right of splits) {
      if (left !== right)
        expect(
          [...evidenceBySplit.get(left)!].some((id) => evidenceBySplit.get(right)!.has(id)),
        ).toBe(false);
    }
});

test("fixture includes the required turn-level decisions in isolated partitions", () => {
  expect(
    fixture.cases.some(
      (item) => item.recallNeeded && item.recentTurns.some((turn) => /[가-힣]/u.test(turn)),
    ),
  ).toBe(true);
  expect(fixture.cases.some((item) => item.expected.handling === "supersession")).toBe(true);
  expect(fixture.cases.some((item) => item.expected.handling === "project_boundary")).toBe(true);
  expect(fixture.cases.some((item) => item.expected.handling === "not_needed")).toBe(true);
  expect(fixture.cases.some((item) => item.expected.handling === "unresolved_empty_search")).toBe(
    true,
  );
  expect(
    fixture.partitions.holdout.some(
      (id) => fixture.cases.find((item) => item.id === id)?.expected.handling === "supersession",
    ),
  ).toBe(true);
});
