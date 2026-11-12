import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  Array as EffectArray,
  Context,
  Data,
  Effect,
  HashSet,
  Iterable,
  Layer,
  MutableHashMap,
  Option,
  Order,
} from "effect";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import type { Fenced } from "../files/paths.ts";
import type { Project } from "../projects/projects.ts";
import { path } from "../runtime/synchronous-path.ts";
import { AgentSkills, StoredSkill } from "./agent-skills.ts";
import { committedSkillFolders } from "./committed.ts";
import {
  Skills,
  maxDescriptionCharacters,
  parseFrontMatter,
  projectSkillsDirectory,
  type Skill,
  type SkillCatalog,
  type SkillDocument,
} from "./skills.ts";

/** The file every skill folder has; the others are what `files` lists. */
const skillDocument = "SKILL.md";

/** A skill a run can use: one the app keeps, or one in a skill folder. */
export type FoundSkill = Data.TaggedEnum<{
  stored: { readonly skill: Skill; readonly stored: StoredSkill };
  folder: { readonly skill: Skill };
}>;
export const FoundSkill = Data.taggedEnum<FoundSkill>();

const make = Effect.gen(function* () {
  const skills = yield* Skills;
  const agentSkills = yield* AgentSkills;
  const digest = yield* Digest.Digest;

  /** A kept skill as a listed one; a promoted skill's copy sits in the user's skill folder. */
  const listed = (project: Fenced<Project>, stored: StoredSkill) =>
    Effect.gen(function* () {
      const text = stored.files[skillDocument] ?? "";
      const { fields } = parseFrontMatter(text);
      const contentHash = Hex.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(text)),
      );
      return {
        scope: stored._tag,
        name: stored.name,
        description: (Option.getOrUndefined(MutableHashMap.get(fields, "description")) ?? "").slice(
          0,
          maxDescriptionCharacters,
        ),
        directory: StoredSkill.$match(stored, {
          promoted: ({ name }) =>
            path.join(projectSkillsDirectory(project.toolFence?.userRoot ?? project.root), name),
          candidate: () => "",
        }),
        contentHash,
      } satisfies Skill;
    });

  /**
   * Every skill a run of `sessionId` sees in `project`, with the folder skills git has committed
   * in the run's folder (all of them outside git) and the skills the app keeps. A kept skill
   * replaces a folder skill of the same name.
   */
  const load = Effect.fn("ProjectSkills.load")(function* (
    project: Fenced<Project>,
    sessionId: string | undefined,
  ) {
    const committed = yield* committedSkillFolders(project.root);
    const [catalog, stored] = yield* Effect.all(
      [skills.catalog(project, committed), agentSkills.visible(project.id, sessionId)],
      { concurrency: "unbounded" },
    );
    const kept = yield* Effect.forEach(stored, (skill) =>
      Effect.map(listed(project, skill), (listedSkill) =>
        FoundSkill.stored({ skill: listedSkill, stored: skill }),
      ),
    );
    const keptNames = HashSet.fromIterable(Iterable.map(stored, (skill) => skill.name));
    return {
      committed,
      catalog,
      found: [
        ...catalog.skills
          .filter((skill) => !HashSet.has(keptNames, skill.name))
          .map((skill) => FoundSkill.folder({ skill })),
        ...kept,
      ],
    };
  });

  const find = Effect.fn("ProjectSkills.find")(function* (
    project: Fenced<Project>,
    sessionId: string | undefined,
    name: string,
  ) {
    const { committed, found } = yield* load(project, sessionId);
    return {
      committed,
      found: EffectArray.findFirst(found, (entry) => entry.skill.name === name),
    };
  });

  return {
    /** The catalog a run of `sessionId` reads, or the settings page without a conversation. */
    catalog: Effect.fn("ProjectSkills.catalog")(function* (
      project: Fenced<Project>,
      sessionId?: string,
    ) {
      const { catalog, found } = yield* load(project, sessionId);
      return {
        ...catalog,
        skills: found.map((entry) => entry.skill),
      } satisfies SkillCatalog;
    }),

    /** The skill a run of `sessionId` would use for `name`, if any. */
    find: (project: Fenced<Project>, sessionId: string | undefined, name: string) =>
      Effect.map(find(project, sessionId, name), ({ found }) => found),

    /** A skill's instructions and the names of its other files. */
    read: Effect.fn("ProjectSkills.read")(function* (
      project: Fenced<Project>,
      sessionId: string | undefined,
      name: string,
    ) {
      const { committed, found } = yield* find(project, sessionId, name);
      return yield* Option.match(found, {
        onNone: () => Effect.succeedNone,
        onSome: FoundSkill.$match({
          stored: ({ skill, stored }) =>
            Effect.succeedSome<SkillDocument>({
              ...skill,
              body: parseFrontMatter(stored.files[skillDocument] ?? "").body,
              files: EffectArray.sort(
                Object.keys(stored.files).filter((file) => file !== skillDocument),
                Order.String,
              ),
            }),
          folder: () => Effect.map(skills.read(project, name, committed), Option.fromNullishOr),
        }),
      });
    }),

    /** One other file of a skill the app keeps, by its path inside the skill. */
    storedFile: Effect.fn("ProjectSkills.storedFile")(function* (
      project: Fenced<Project>,
      sessionId: string | undefined,
      name: string,
      file: string,
    ) {
      const { found } = yield* find(project, sessionId, name);
      return Option.flatMap(Option.filter(found, FoundSkill.$is("stored")), ({ stored }) =>
        Option.fromNullishOr(stored.files[file]),
      );
    }),
  };
});

/**
 * The skills a run sees: built-in and the user's, the project's committed skill folders, and the
 * skills the app keeps for the project and the run's conversation.
 */
export class ProjectSkills extends Context.Service<ProjectSkills, Effect.Success<typeof make>>()(
  "memory-agent/skills/project-skills/ProjectSkills",
) {
  /** Also gives the `AgentSkills` it reads, which `CodeSkills` saves to. */
  static readonly layer = Layer.effect(ProjectSkills, make).pipe(
    Layer.provideMerge(AgentSkills.layer),
    Layer.provide(NodeCrypto.layer),
  );
}
