import { Array as EffectArray, Effect, Option, Schema } from "effect";
import type { SecureRandom } from "effect/crypto";
import type { StoredMessage, StoredUserMessage } from "../chat-store/schema.ts";
import type { Fenced } from "../files/paths.ts";
import type { RunHook } from "../loop/run.ts";
import type { Project } from "../projects/projects.ts";
import { fallbackLogged } from "../runtime/logged-failures.ts";
import type { SkillSearch } from "../skills/skill-search.ts";
import { orchestratorMessage } from "./orchestrator-message.ts";

/** How many skills a user's message is suggested at most. */
export const suggestedSkills = 3;
/** How much of a suggested skill's description goes along; find_skill and read_skill give all of it. */
const suggestedDescriptionCharacters = 200;

const isText = Schema.is(Schema.String);

/** The user's own message: the orchestrator's messages are user messages to the model too. */
const isUserTurn = (message: StoredMessage): message is typeof StoredUserMessage.Type =>
  message.role === "user" && message.orchestrator === undefined;

const textOf = (message: typeof StoredUserMessage.Type) =>
  isText(message.content)
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("\n");

/**
 * Suggests the skills that may fit the user's message, in the orchestrator's message right after
 * it (decisions.md "사용자 메시지마다 맞을 수 있는 스킬을 대화에 붙인다 (2026-11-13)"). Only a run the
 * user started gets one, before its first model step, when the conversation ends on the user's
 * message: a follow-up run ends on the orchestrator's message and a resumed one on a tool result.
 * Kept in the thread, it is sent where it was, so later requests keep the prompt cache. It never
 * waits for the embedding model to load: until then the suggestions are by words alone.
 */
export const skillSuggestions = (services: {
  readonly search: SkillSearch["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => ({
  hookFor: (project: Fenced<Project>, sessionId: string): RunHook => ({
    joining: (_scope, conversation) =>
      Option.match(
        Option.filter(
          Option.map(Option.filter(EffectArray.last(conversation), isUserTurn), textOf),
          (text) => text.trim().length > 0,
        ),
        {
          onNone: () => Effect.succeed<StoredMessage[]>([]),
          onSome: (text) =>
            services.search.find(project, sessionId, text, suggestedSkills, false).pipe(
              Effect.flatMap(({ skills }) =>
                EffectArray.match(skills, {
                  onEmpty: () => Effect.succeed<StoredMessage[]>([]),
                  onNonEmpty: (found) =>
                    Effect.map(
                      Effect.flatMap(
                        services.crypto.uuidV7(),
                        orchestratorMessage(
                          {
                            next: "run",
                            ended: { background: 0, subagent: 0 },
                            skills: found.map((skill) => skill.name),
                          },
                          [
                            [
                              "Skills that may fit the user's message above, found as it was sent. Use one only when it fits the task: read it with read_skill first, or run a code skill with run_skill. Skills are saved and deleted while the conversation goes on, so find_skill gives them as they are now.",
                              ...found.map(
                                (skill) =>
                                  `- ${skill.name} (${skill.scope}): ${skill.description.slice(0, suggestedDescriptionCharacters)}`,
                              ),
                            ].join("\n"),
                          ],
                        ),
                      ),
                      (message): StoredMessage[] => [message],
                    ),
                }),
              ),
              fallbackLogged("Skill suggestions not made", (): StoredMessage[] => []),
            ),
        },
      ),
  }),
});
