import { Context, Effect, Layer, Schema } from "effect";
import { CodexAppServer } from "./app-server.ts";

const SkillList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      skills: Schema.Array(Schema.Struct({ path: Schema.String, enabled: Schema.Boolean })),
    }),
  ),
});
const Written = Schema.Struct({ effectiveEnabled: Schema.Boolean });

const make = Effect.gen(function* () {
  const codex = yield* CodexAppServer;

  return {
    /**
     * Turns off every skill codex found on its own, and returns how many were still on.
     *
     * codex reads the user's `~/.agents/skills` (and a project's, when it runs in one) and tells
     * the model about them. This app reads the same folders and offers them through `read_skill`,
     * with its own rule that a skill is guidance, not permission — so the model heard of every skill
     * twice, once without that rule. codex's own bundled skills are already off in its config.
     *
     * codex is asked what it sees rather than told what this app found, so a path spelled another
     * way, or a folder this app does not read, cannot slip through. A skill is turned off by its
     * `SKILL.md` path: a folder path turns nothing off, and a name cannot tell apart two skills that
     * share one. The setting is written to this app's CODEX_HOME, never to the user's `~/.codex`,
     * and takes effect without restarting codex, so a skill added while the app runs is off by the
     * next run.
     */
    silenceOwnSkills: Effect.gen(function* () {
      const listed = yield* codex.request("skills/list", { cwds: [codex.home] }, SkillList);
      const on = listed.data.flatMap((group) => group.skills).filter((skill) => skill.enabled);
      yield* Effect.forEach(
        on,
        (skill) =>
          codex.request("skills/config/write", { path: skill.path, enabled: false }, Written),
        { discard: true },
      );
      return on.length;
    }),
  };
});

/** Keeps codex's own skill list out of the model's context; this app offers skills itself. */
export class CodexSkills extends Context.Tag("memory-agent/CodexSkills")<
  CodexSkills,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(CodexSkills, make);
}
