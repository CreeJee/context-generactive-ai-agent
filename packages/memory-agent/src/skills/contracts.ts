import { Schema } from "effect";

/**
 * Skills as the settings page shows them. This module imports no server code, so the browser
 * bundle can use it; `skills.ts` builds the catalog.
 */

/**
 * Where a skill comes from. `builtin` ships with this app; the user's own (`global`) and the
 * project's replace a built-in skill of the same name, so any of them can be overridden.
 */
export const SkillScope = Schema.Literals(["builtin", "global", "project"]);
export type SkillScope = typeof SkillScope.Type;

export const Skill = Schema.Struct({
  scope: SkillScope,
  name: Schema.String,
  description: Schema.String,
  directory: Schema.String,
  /** SHA-256 of the exact SKILL.md used to discover this skill. */
  contentHash: Schema.String,
});
export type Skill = typeof Skill.Type;

export const SkillProblem = Schema.Struct({
  scope: SkillScope,
  directory: Schema.String,
  problem: Schema.Literals(["no_description", "too_large", "unreadable"]),
});
export type SkillProblem = typeof SkillProblem.Type;

export const SkillCatalog = Schema.Struct({
  directories: Schema.Array(Schema.Struct({ scope: SkillScope, path: Schema.String })),
  /** Project skills replace global ones with the same name. */
  skills: Schema.Array(Skill),
  problems: Schema.Array(SkillProblem),
});
export type SkillCatalog = typeof SkillCatalog.Type;
