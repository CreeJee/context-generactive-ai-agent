import { Array as Arr, Clock, Context, DateTime, Effect, Layer, Result, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import { ToolFailed } from "../tools/failure.ts";
import { runTool, type RunTool } from "../tools/run-tool.ts";

/**
 * What words mean in a project, kept as one list per project (docs/decisions.md "Goal은 맞춘 뒤에
 * 맡긴다"). The conversation that shapes a Goal finds what each word of the request means, from the
 * user, the code, a document or the web, and saves it here. Every later run of the project, its
 * card agents and verifiers included, starts with the list, so one word keeps one meaning across
 * cards and across Goals.
 */

/** How many terms one project keeps. The whole list is sent with every run. */
export const maxProjectTerms = 80;

/** One line of text of at most `characters`, starting with something written. */
const oneLine = (characters: number) =>
  Schema.String.check(Schema.isPattern(/^\S[^\n\r]*$/), Schema.isMaxLength(characters));

/** Where a term's meaning was found. A guess is not a source: it is a question for the user. */
export const TermSource = Schema.Literals(["user", "code", "document", "web"]);
export type TermSource = typeof TermSource.Type;

export const ProjectTerm = Schema.Struct({
  term: oneLine(80).annotate({
    description:
      "The word or phrase as the project writes it. Letter case does not make another term.",
  }),
  meaning: oneLine(400).annotate({
    description:
      "What it means in this project, in one or two plain sentences, and what it is not when another meaning is likely.",
  }),
  source: TermSource.annotate({
    description:
      "Where the meaning was found: user (the user said it), code (the project's code names or does it), document (a file of the project or one the user gave), web (an outside page).",
  }),
  reference: oneLine(300).annotate({
    description:
      "What shows the meaning: the user's words quoted, a file path with the name or line, or a URL.",
  }),
});
export type ProjectTerm = typeof ProjectTerm.Type;

export const SaveProjectTermsInput = Schema.Struct({
  terms: Schema.optionalKey(
    Schema.Array(ProjectTerm).check(Schema.isMaxLength(maxProjectTerms)).annotate({
      description:
        "Terms to put on the list. One that is already listed gets the meaning, source and reference given here.",
    }),
  ),
  remove: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(maxProjectTerms)).annotate({
      description: "Listed terms to take off the list: ones the project no longer uses.",
    }),
  ),
});

export const saveProjectTermsSpec = {
  name: "save_project_terms",
  description: `Keep what words mean in this project on the project's term list, which every later conversation, card agent and verifier of the project starts with. Save a term once you found what it means: the user said it, the project's code or a document shows it, or an outside page defines it. Never save a guess: when you could not find what a word of the request means, ask the user. Save a term when the request uses a word that could be read two ways, a word the project uses in its own sense, or two words for one thing (keep one and say in its meaning which word it replaces). When the user corrects a meaning, save the term again with the corrected one. The list holds at most ${maxProjectTerms} terms. Returns the list as it is now.`,
  parameters: SaveProjectTermsInput,
} as const;

/** The list as every run of the project reads it, after the system prompts before it. */
const termsPrompt = (terms: ReadonlyArray<ProjectTerm>) =>
  [
    "[Project terms]",
    "What words mean in this project, kept from earlier conversations. Use each term with the meaning given here, in what you write and in the names you choose: no other word for the same thing, and not the same word for another thing. When the user, the code or your task uses one of them with another meaning, say so instead of picking one silently.",
    ...terms.map(
      ({ term, meaning, source, reference }) => `- ${term}: ${meaning} (${source}: ${reference})`,
    ),
  ].join("\n");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listed = SqlSchema.findAll({
    Request: Schema.String,
    Result: ProjectTerm,
    execute: (projectId) => sql`
      SELECT term, meaning, source, reference FROM project_terms
      WHERE project_id = ${projectId} ORDER BY rowid`,
  });
  const removed = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String, term: Schema.String }),
    Result: Schema.Struct({ term: Schema.String }),
    execute: ({ projectId, term }) => sql`
      DELETE FROM project_terms
      WHERE project_id = ${projectId} AND term = ${term} RETURNING term`,
  });
  const isoNow = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );

  /** The project's terms, in the order they were first saved. */
  const list = (projectId: string) => listed(projectId);

  /**
   * Takes `remove` off the list and puts `terms` on it, as one change: a list that would hold more
   * than {@link maxProjectTerms} is refused and nothing changes. Gives the list as it is afterwards,
   * and the terms of `remove` that were not on it.
   */
  const change = Effect.fn("ProjectTerms.change")(function* (
    projectId: string,
    { terms = [], remove = [] }: typeof SaveProjectTermsInput.Type,
  ) {
    const savedAt = yield* isoNow;
    const taken = yield* Effect.forEach(Arr.dedupe(remove.map((term) => term.trim())), (term) =>
      Effect.map(removed({ projectId, term }), (rows) => ({ term, found: rows.length > 0 })),
    );
    yield* Effect.forEach(
      terms,
      ({ term, meaning, source, reference }) => sql`
        INSERT INTO project_terms (project_id, term, meaning, source, reference, saved_at)
        VALUES (${projectId}, ${term.trim()}, ${meaning.trim()}, ${source}, ${reference.trim()}, ${savedAt})
        ON CONFLICT(project_id, term) DO UPDATE
          SET term = excluded.term, meaning = excluded.meaning, source = excluded.source,
              reference = excluded.reference, saved_at = excluded.saved_at`,
      { discard: true },
    );
    const now = yield* list(projectId);
    yield* Effect.when(
      Effect.fail(
        ToolFailed.make({
          code: "too_many_terms",
          tag: "ProjectTermsFull",
          detail: `The list would hold ${now.length} terms and holds at most ${maxProjectTerms}. In the same call, take off with remove the ones the project no longer uses. Nothing was changed.`,
          refused: true,
        }),
      ),
      Effect.succeed(now.length > maxProjectTerms),
    );
    const notListed = Arr.filterMap(taken, ({ term, found }) =>
      found ? Result.failVoid : Result.succeed(term),
    );
    return notListed.length === 0 ? { terms: now } : { terms: now, notListed };
  }, sql.withTransaction);

  return {
    list,
    change,

    /**
     * The term list, read once as the run starts and sent after the system prompts the hooks
     * before this one chose. A change the run itself saves shows in the next run, so the run's
     * prompt stays the same from its first request to its last. A project without terms gets no
     * prompt.
     */
    hookFor: Effect.fnUntraced(function* (projectId: string) {
      const prompt = yield* Effect.cached(
        list(projectId).pipe(
          Effect.map((terms) => (terms.length === 0 ? [] : [termsPrompt(terms)])),
          Effect.mapError(asRunFailed),
        ),
      );
      return {
        request: (_scope, request) =>
          Effect.map(prompt, (added) => ({ ...request, system: [...request.system, ...added] })),
      } satisfies RunHook;
    }),

    /** The run's `save_project_terms` tool. A failure of the store names no statement. */
    toolFor: (projectId: string): RunTool =>
      runTool({
        ...saveProjectTermsSpec,
        handler: (input) =>
          change(projectId, input).pipe(
            Effect.catchTags({
              SqlError: (error) =>
                Effect.fail(
                  ToolFailed.make({
                    code: "project_terms_store_failed",
                    tag: error._tag,
                    detail: "The term list could not be saved; try again or tell the user.",
                  }),
                ),
              SchemaError: (error) =>
                Effect.fail(
                  ToolFailed.make({
                    code: "project_terms_store_failed",
                    tag: error._tag,
                    detail: "The term list could not be read back; try again or tell the user.",
                  }),
                ),
            }),
          ),
      }),
  };
});

/** Each project's term list. Reads and writes go through the owner's own `SqlClient`. */
export class ProjectTerms extends Context.Service<ProjectTerms, Effect.Success<typeof make>>()(
  "memory-agent/projects/terms/ProjectTerms",
) {
  static readonly layer = Layer.effect(ProjectTerms, make);
}
