import { Schema } from "effect";

const shortText = Schema.String.check(Schema.isMaxLength(4000));
export const HarnessProfile = Schema.Struct({
  rolePrompt: shortText,
  memoryToolDescription: shortText,
  retrievalLeadLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  retrievalTokenLimit: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 1200 })),
});
export type HarnessProfile = typeof HarnessProfile.Type;
export const baselineProfile: HarnessProfile = {
  rolePrompt: "",
  memoryToolDescription: "",
  retrievalLeadLimit: 5,
  retrievalTokenLimit: 600,
};
export const Component = Schema.Literals([
  "prompt",
  "client_tool",
  "context_mgmt",
  "memory",
  "control_flow",
  "skill",
  "subagent",
  "config",
  "output_plumbing",
]);
export type Component = typeof Component.Type;
export const Edit = Schema.Struct({ component: Component, hypothesis: Schema.NonEmptyString });
export const Proposal = Schema.Struct({ profile: HarnessProfile, edits: Schema.Array(Edit) });
export type Proposal = typeof Proposal.Type;
export const Measurement = Schema.Struct({
  score: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  coding: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  memory: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  tokens: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0))),
});
export type Measurement = typeof Measurement.Type;
export const Settings = Schema.Struct({
  enabled: Schema.Boolean,
  maxTokens: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 1000000 })),
  maxMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 })),
});
export type RrsiSettings = typeof Settings.Type;
export const defaultSettings: RrsiSettings = { enabled: true, maxTokens: 200000, maxMinutes: 30 };
export const Version = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  profile: HarnessProfile,
  kind: Schema.Literals(["profile", "code"]),
  sourceCommit: Schema.NullOr(Schema.String),
  artifactHash: Schema.String,
  createdAt: Schema.Finite,
});
export type HarnessVersion = typeof Version.Type;
export const Candidate = Schema.Struct({
  kind: Schema.Literals(["profile", "code"]),
  imageId: Schema.NullOr(Schema.String),
  id: Schema.String,
  round: Schema.Int,
  profile: HarnessProfile,
  edits: Schema.Array(Edit),
  measurement: Schema.NullOr(Measurement),
  decision: Schema.String,
  diff: Schema.String,
  branch: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
});
export type CandidateRecord = typeof Candidate.Type;
export const Experiment = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  startedAt: Schema.Finite,
  finishedAt: Schema.NullOr(Schema.Finite),
  model: Schema.String,
  endpoint: Schema.String,
  baseVersion: Schema.String,
  baselineImage: Schema.optionalKey(Schema.String),
  baselines: Schema.optionalKey(Schema.Array(Measurement)),
  validationBase: Schema.optionalKey(Measurement),
  validationNew: Schema.optionalKey(Measurement),
  sealedBase: Schema.optionalKey(Measurement),
  sealedNew: Schema.optionalKey(Measurement),
  tokens: Schema.Finite,
  reason: Schema.String,
  candidates: Schema.Array(Candidate),
});
export type ExperimentRecord = typeof Experiment.Type;
export const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literal("settings"), settings: Settings }),
  Schema.Struct({ action: Schema.Literals(["start", "stop"]) }),
  Schema.Struct({ action: Schema.Literal("restore"), versionId: Schema.String }),
]);
export const CodeEdit = Schema.Struct({
  path: Schema.NonEmptyString,
  before: Schema.NonEmptyString.check(Schema.isMaxLength(10000)),
  after: Schema.String.check(Schema.isMaxLength(10000)),
});
export const CodeProposal = Schema.Struct({
  edits: Schema.Array(Edit),
  files: Schema.Array(CodeEdit),
});
export type CodeProposal = typeof CodeProposal.Type;
