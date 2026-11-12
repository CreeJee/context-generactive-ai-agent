import { isTruthy } from "../truthy.ts";
import {
  Array as EffectArray,
  Clock,
  Context,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Function as EffectFunction,
  HashSet,
  Layer,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";
import { folderMentions, isPlainPath, replaceFolderMentions } from "../files/path-policy.ts";
import { optionalProperty } from "../optional-property.ts";
import { resolveProjectPath, type Fenced } from "../files/paths.ts";
import { readTextFileEffect, sha256 } from "../files/text.ts";
import { JsonValue } from "../json.ts";
import type { Project } from "../projects/projects.ts";
import { path } from "../runtime/synchronous-path.ts";
import { NetworkHost, type SaveCodeSkillInput } from "../tools/definitions.ts";
import { AgentSkills, type SkillFiles } from "./agent-skills.ts";
import { FoundSkill, ProjectSkills } from "./project-skills.ts";

/**
 * Project code skills: a ts program that calls the run's tools, or a sh script, the only way the
 * model runs a host command. Each one has the files of a standard skill folder, `SKILL.md` with
 * `scripts/run.ts` or `scripts/run.sh`. A saved one is a candidate the app keeps for the
 * conversation that saved it (`AgentSkills`); a committed folder `.agents/skills/<name>` in the
 * run's folder runs too. A program runs only while its exact content was approved when it was
 * saved.
 */

export type SkillRuntime = "ts" | "sh";
type SkillProgram = (typeof SaveCodeSkillInput.Type)["program"];

export const codeSkillDirectory = (name: string) => `.agents/skills/${name}`;
/** A code skill's program, by its path inside the skill. */
const codeSkillFile = (runtime: SkillRuntime) => `scripts/run.${runtime}`;
const codeSkillScript = (name: string, runtime: SkillRuntime) =>
  `${codeSkillDirectory(name)}/${codeSkillFile(runtime)}`;
const skillDocumentFile = "SKILL.md";

/** Where a saved skill can run, as its save result tells the model. */
const savedSkillScope =
  "This conversation: its runs, and the cards and verifiers of its Goal, can run the skill now. A review later decides whether the project's other conversations get it too.";

export class CodeSkillRejected extends Schema.TaggedError<
  CodeSkillRejected,
  { readonly brand: unique symbol }
>()("CodeSkillRejected", {
  reason: Schema.Literals([
    "builtin_overlap",
    "not_code_skill",
    "network_line",
    "input_line",
    "input_schema",
    "not_found",
    "not_approved",
    "ts_skill",
    "absolute_path",
  ]),
  detail: Schema.String,
}) {
  override get message() {
    return `${this.reason}: ${this.detail}`;
  }
}

/**
 * Programs a built-in tool already covers, and that tool. A script made only of these wraps a
 * built-in; as a filter after another program (`pnpm test | tail -50`) they are fine.
 */
const coveredBy = {
  ls: "list_files",
  find: "list_files",
  fd: "list_files",
  tree: "list_files",
  cat: "read_file",
  head: "read_file",
  tail: "read_file",
  less: "read_file",
  more: "read_file",
  nl: "read_file",
  bat: "read_file",
  sed: "read_file or edit_file",
  awk: "read_file or search_files",
  grep: "search_files",
  egrep: "search_files",
  fgrep: "search_files",
  rg: "search_files",
  ag: "search_files",
  ack: "search_files",
  touch: "write_file",
  tee: "write_file",
  rm: "delete_file",
} as const;
const coveredTool = (program: string) =>
  Object.entries(coveredBy).find(([name]) => name === program)?.[1];

/** Words that run nothing of their own; the program after them is what counts. */
const prefixes = HashSet.make("command", "exec", "env", "time", "nice");
/** Steps that only set up the shell. */
const setup = HashSet.make("cd", "set", "export", "true", ":", "echo", "printf", "exit");

/** The program each step of a script starts with: the first of every `;`/`&&`/`||` step's pipeline. */
const leadingPrograms = (script: string) =>
  EffectArray.filterMap(
    EffectArray.filterMap(script.split("\n"), (line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("#") ? Result.succeed(trimmed) : Result.failVoid;
    }).flatMap((line) => line.split(/;|&&|\|\|/)),
    (step) => {
      const words = (step.split("|")[0] ?? "").trim().split(/\s+/);
      const first =
        words.find(
          (word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && !HashSet.has(prefixes, word),
        ) ?? "";
      const program = first.split("/").at(-1) ?? "";
      return program !== "" && !HashSet.has(setup, program)
        ? Result.succeed(program)
        : Result.failVoid;
    },
  );

/** Refuses a script that only wraps what built-in tools do. */
export const builtinOverlap = (script: string): Option.Option<CodeSkillRejected> => {
  const programs = leadingPrograms(script);
  const tools = programs.map(coveredTool);
  return programs.length > 0 && tools.every(isTruthy)
    ? Option.some(
        CodeSkillRejected.make({
          reason: "builtin_overlap",
          detail: `${EffectArray.dedupe(programs).join(", ")} ${programs.length === 1 ? "is" : "are"} covered by ${EffectArray.dedupe(tools).join(", ")}. Call those tools directly, or combine them in a ts skill; save a sh skill only for what no built-in tool does (builds, tests, git, package managers, project commands).`,
        }),
      )
    : Option.none();
};

/**
 * First line of a script that may use the network, naming its hosts. It is part of the approved
 * text, so the host list is approved, hashed and shown together with the script.
 */
const networkMarker = "# run_skill network:";

/** The hosts an approved script may reach, from its first line. */
export const scriptNetwork = (text: string): readonly string[] => {
  const first = text.split("\n", 1)[0] ?? "";
  return first.startsWith(networkMarker)
    ? first.slice(networkMarker.length).trim().split(/\s+/).filter(Schema.is(NetworkHost))
    : [];
};

/**
 * First line of a ts program that takes input: the JSON Schema of that input. It is part of the
 * approved text, so the schema is approved, hashed and shown together with the code.
 */
const inputMarker = "// run_skill input:";

/** The JSON Schema a ts skill declares for its input. */
const InputSchema = Schema.Record(Schema.String, Schema.Unknown);
export type InputSchema = typeof InputSchema.Type;
const decodeInputSchema = Schema.decodeUnknownOption(Schema.fromJsonString(InputSchema));
/** run_skill's input is an object, so only an object schema can describe it. */
const isObjectSchema = Schema.is(Schema.Struct({ type: Schema.Literal("object") }));

/** The JSON Schema an approved program's input must match, from its first line. */
const programInput = (text: string): Option.Option<InputSchema> => {
  const first = text.split("\n", 1)[0] ?? "";
  return first.startsWith(inputMarker)
    ? decodeInputSchema(first.slice(inputMarker.length).trim())
    : Option.none();
};

/** The parts of a JSON Schema that an input signature shows. */
interface SignatureSchema {
  readonly type?: string | readonly string[];
  readonly properties?: { readonly [key: string]: SignatureSchema };
  readonly required?: readonly string[];
  readonly items?: SignatureSchema;
  readonly enum?: readonly JsonValue[];
}
const SignatureSchema: Schema.Codec<SignatureSchema> = Schema.suspend(() =>
  Schema.Struct({
    type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    properties: Schema.optionalKey(Schema.Record(Schema.String, SignatureSchema)),
    required: Schema.optionalKey(Schema.Array(Schema.String)),
    items: Schema.optionalKey(SignatureSchema),
    enum: Schema.optionalKey(Schema.Array(JsonValue)),
  }),
);
const decodeSignatureSchema = Schema.decodeUnknownOption(SignatureSchema);

const schemaSignature = (schema: SignatureSchema): string => {
  const types =
    schema.type === undefined
      ? []
      : Schema.is(Schema.String)(schema.type)
        ? [schema.type]
        : schema.type;
  return schema.enum !== undefined
    ? schema.enum.map((value) => JSON.stringify(value)).join(" | ")
    : types.length === 0
      ? "JSON"
      : types.map((type) => typeSignature(type, schema)).join(" | ");
};

const typeSignature = (type: string, schema: SignatureSchema): string =>
  Match.value(type).pipe(
    Match.when("object", () => {
      const required = HashSet.fromIterable(schema.required ?? []);
      const fields = Object.entries(schema.properties ?? {}).map(
        ([key, field]) =>
          `${key}${HashSet.has(required, key) ? "" : "?"}: ${schemaSignature(field)}`,
      );
      return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
    }),
    Match.when(
      "array",
      () => `${schema.items === undefined ? "JSON" : schemaSignature(schema.items)}[]`,
    ),
    Match.when("integer", () => "number"),
    Match.orElse((name) => name),
  );

/** Longer than this, the signature would crowd out the description it ends. */
const maxSignatureCharacters = 300;

/** A ts skill's input as a short TypeScript-like type, for the skill list. */
export const inputSignature = (schema: Option.Option<InputSchema>) =>
  Option.match(schema, {
    onNone: () => "none",
    onSome: (declared) => {
      const text = Option.match(decodeSignatureSchema(declared), {
        onNone: () => "an object",
        onSome: schemaSignature,
      });
      return text.length > maxSignatureCharacters
        ? "an object; its JSON Schema is the first line of scripts/run.ts"
        : text;
    },
  });

const withNewline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);

/** The script file's text: the declared input or hosts on its first line, then the program. */
const programText = (program: SkillProgram) =>
  Match.value(program).pipe(
    Match.discriminatorsExhaustive("runtime")({
      ts: ({ code, input }) =>
        [
          ...(input === undefined ? [] : [`${inputMarker} ${JSON.stringify(input)}\n`]),
          withNewline(code),
        ].join(""),
      sh: ({ script, network = [] }) => {
        const hosts = EffectArray.dedupe(network);
        return [
          ...(hosts.length > 0 ? [`${networkMarker} ${hosts.join(" ")}\n`] : []),
          withNewline(script),
        ].join("");
      },
    }),
  );

const hasLineStarting = (text: string, marker: string) =>
  text.split("\n").some((line) => line.trim().startsWith(marker));

/** Why a program cannot be saved as given, if it cannot. */
const programRefusal = (program: SkillProgram): Option.Option<CodeSkillRejected> =>
  Match.value(program).pipe(
    Match.discriminatorsExhaustive("runtime")({
      ts: ({ code, input }) =>
        hasLineStarting(code, inputMarker)
          ? Option.some(
              CodeSkillRejected.make({
                reason: "input_line",
                detail: `Remove the "${inputMarker}" line from code and give the schema as input; it is written from input.`,
              }),
            )
          : input !== undefined && !isObjectSchema(input)
            ? Option.some(
                CodeSkillRejected.make({
                  reason: "input_schema",
                  detail:
                    'input must be a JSON Schema of type "object", for example {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}.',
                }),
              )
            : Option.none(),
      sh: ({ script }) =>
        Option.orElse(builtinOverlap(script), () =>
          hasLineStarting(script, networkMarker)
            ? Option.some(
                CodeSkillRejected.make({
                  reason: "network_line",
                  detail: `Remove the "${networkMarker}" line from script and list those hosts in network; it is written from network.`,
                }),
              )
            : Option.none(),
        ),
    }),
  );

/** A program's text, and the same program with another text. */
const programBody = (program: SkillProgram) =>
  Match.value(program).pipe(
    Match.discriminatorsExhaustive("runtime")({
      ts: (ts) => ({ text: ts.code, with: (code: string): SkillProgram => ({ ...ts, code }) }),
      sh: (sh) => ({
        text: sh.script,
        with: (script: string): SkillProgram => ({ ...sh, script }),
      }),
    }),
  );

/**
 * In a kanban card, the program with the card's own folder written as the user's project folder,
 * or none when it does not name the card's folder. The card's folder is gone once the card is
 * merged, and a skill run in a card reads the user's folder as the card's own copy again
 * (`run_skill`; files only the user's folder has stay there), so the program means the same in
 * the card and after it. Outside a card the run's
 * folder is the user's project folder, so its absolute path is kept as written. A user's folder
 * whose path a program cannot take as it is (spaces, quotes, shell characters) is refused.
 */
const cardFolderRewritten = Effect.fnUntraced(function* (
  project: Fenced<Project>,
  program: SkillProgram,
) {
  const body = programBody(program);
  const own = (yield* folderMentions(project, body.text)).filter(({ folder }) => folder === "root");
  const userRoot = Option.filter(Option.fromNullishOr(project.toolFence?.userRoot), () =>
    EffectArray.isReadonlyArrayNonEmpty(own),
  );
  return yield* Option.match(userRoot, {
    onNone: () => Effect.succeed(Option.none<SkillProgram>()),
    onSome: (folder) =>
      isPlainPath(folder)
        ? Effect.succeedSome(body.with(replaceFolderMentions(body.text, own, folder)))
        : Effect.fail(
            CodeSkillRejected.make({
              reason: "absolute_path",
              detail: `The program names this card's own folder by its absolute path (${EffectArray.dedupe(own.map(({ spelling }) => spelling)).join(", ")}), which is gone once the card is merged. Use paths relative to the folder the skill runs in, like ./src or "$PWD/src". Then save it again.`,
            }),
          ),
  });
});

/** What a card's save result tells the model when the program names the user's project folder. */
const cardFolderNote = (project: Fenced<Project>) =>
  `In this kanban card, paths to the card's own folder (${project.root}) are saved as the user's project folder (${project.toolFence?.userRoot ?? project.root}). A skill run in a card reads that folder as the card's own copy, except files the copy does not have because git does not track them (like .env or node_modules), which it reads in the user's folder. So the skill works here and after the card is merged.`;

/** How SKILL.md tells a reader to run the skill. */
const runLine = (name: string, program: SkillProgram) =>
  Match.value(program).pipe(
    Match.discriminatorsExhaustive("runtime")({
      ts: () =>
        `Run with the \`run_skill\` tool (name \`${name}\`, with \`input\`). The program is \`scripts/run.ts\`: the body of an async function that reads \`input\` and calls this app's tools as \`external_<tool name>\`, run in the app's code sandbox.`,
      sh: () =>
        `Run with the \`run_skill\` tool (name \`${name}\`). The script is \`scripts/run.sh\`; arguments arrive as \`$1\`, \`$2\`, ….`,
    }),
  );

/**
 * SKILL.md for a code skill. Front matter values are JSON strings, which YAML reads as-is. A ts
 * skill's description ends with its input, so the skill list shows how to call it.
 */
const skillDocument = (input: {
  readonly name: string;
  readonly description: string;
  readonly usage: string | undefined;
  readonly program: SkillProgram;
}) =>
  [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(
      [
        input.description.replaceAll(/\s+/g, " ").trim(),
        ...(input.program.runtime === "ts"
          ? [`Input: ${inputSignature(Option.fromUndefinedOr(input.program.input))}.`]
          : []),
      ].join(" "),
    )}`,
    "---",
    "",
    ...(isTruthy(input.usage?.trim()) ? [input.usage.trim(), ""] : []),
    runLine(input.name, input.program),
    "",
  ].join("\n");

/** A saved skill's program as it is now. */
export type SavedProgram = Data.TaggedEnum<{
  ts: {
    readonly code: string;
    readonly sha256: string;
    readonly input: Option.Option<InputSchema>;
  };
  sh: { readonly text: string; readonly sha256: string; readonly network: readonly string[] };
}>;
export const SavedProgram = Data.taggedEnum<SavedProgram>();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectSkills = yield* ProjectSkills;
  const agentSkills = yield* AgentSkills;
  const platform = yield* Effect.context<FileSystem.FileSystem | SecureRandom.SecureRandom>();
  // The table keeps its name from when every saved skill was a shell script.
  const approved = (projectId: string, name: string, sha256: string) =>
    Effect.map(
      sql`
        SELECT 1 FROM shell_skill_approvals
        WHERE project_id = ${projectId} AND name = ${name} AND script_sha256 = ${sha256}`,
      (rows) => rows.length > 0,
    );

  const notFound = (name: string) =>
    CodeSkillRejected.make({
      reason: "not_found",
      detail: `${name} has no scripts/run.ts or scripts/run.sh. Save it with save_code_skill first.`,
    });

  /** A program from its text: a ts program with the input it declares, or a sh script. */
  const savedProgram = (runtime: SkillRuntime, text: string, sha256: string) =>
    runtime === "ts"
      ? SavedProgram.ts({ code: text, sha256, input: programInput(text) })
      : SavedProgram.sh({ text, sha256, network: scriptNetwork(text) });

  /** The script of a committed skill folder in the run's folder, as it is now. */
  const folderScript = Effect.fn("CodeSkills.folderScript")(function* (
    project: Project,
    folder: string,
    runtime: SkillRuntime,
  ) {
    const path = codeSkillScript(folder, runtime);
    const target = yield* resolveProjectPath(project.root, path, "file");
    const file = yield* readTextFileEffect({ absolute: target.absolute, path });
    return savedProgram(runtime, file.text, file.sha256);
  });

  /** A stored skill's ts program, or else its sh script. */
  const storedProgram = (files: SkillFiles) =>
    Option.firstSomeOf(
      (["ts", "sh"] as const).map((runtime) =>
        Option.map(Option.fromNullishOr(files[codeSkillFile(runtime)]), (text) =>
          savedProgram(runtime, text, sha256(text)),
        ),
      ),
    );

  /** A committed skill folder's ts program, or else its sh script, or none when it has neither. */
  const folderProgram = (project: Project, folder: string) =>
    folderScript(project, folder, "ts").pipe(
      Effect.catchIf(
        (rejection) =>
          Predicate.isTagged(rejection, "PathRejected") && rejection.reason === "not_found",
        () => folderScript(project, folder, "sh"),
      ),
      Effect.asSome,
      Effect.catchIf(
        (rejection) =>
          Predicate.isTagged(rejection, "PathRejected") && rejection.reason === "not_found",
        () => Effect.succeedNone,
      ),
    );

  /**
   * A skill's program, or none when it is only instructions. Only the project's own folders hold
   * programs; a user's or built-in skill folder is instructions.
   */
  const programOf = (project: Project, found: FoundSkill) =>
    FoundSkill.$is("stored")(found)
      ? Effect.succeed(storedProgram(found.stored.files))
      : found.skill.scope === "project"
        ? folderProgram(project, path.basename(found.skill.directory))
        : Effect.succeedNone;

  /**
   * The program of the code skill a run of `sessionId` uses under `name`, as it is now: the
   * conversation's candidate, the promoted skill, or the committed skill folder.
   */
  const program = Effect.fn("CodeSkills.program")(function* (
    project: Fenced<Project>,
    sessionId: string | undefined,
    name: string,
  ) {
    const found = yield* projectSkills.find(project, sessionId, name);
    const saved = Option.flatten(
      yield* Effect.transposeOption(Option.map(found, (skill) => programOf(project, skill))),
    );
    return yield* Effect.fromOption(saved, () => notFound(name));
  });

  return {
    /**
     * Saves (or replaces) a code skill as a candidate of the conversation `sessionId`, which alone
     * runs it until a review promotes it. The call itself was approved under the project's
     * policy, so the saved program counts as approved; `full` mode records nothing, so leaving it
     * asks again. A skill keeps one program: saving it in the other runtime replaces the old one.
     */
    save: Effect.fn("CodeSkills.save")(function* (
      project: Fenced<Project>,
      sessionId: string,
      input: {
        readonly name: string;
        readonly description: string;
        readonly usage: string | undefined;
        readonly program: SkillProgram;
      },
    ) {
      yield* Option.match(programRefusal(input.program), {
        onNone: () => Effect.void,
        onSome: Effect.fail,
      });
      const program = Option.getOrElse(
        yield* cardFolderRewritten(project, input.program),
        () => input.program,
      );
      // A skill of this name that is only instructions keeps its name; a program would hide it.
      const existing = yield* projectSkills.find(project, sessionId, input.name);
      const existingProgram = yield* Option.match(existing, {
        onNone: () => Effect.succeedNone,
        onSome: (skill) => programOf(project, skill),
      });
      const projectInstructions =
        Option.exists(
          existing,
          (skill) => skill.skill.scope !== "builtin" && skill.skill.scope !== "global",
        ) && Option.isNone(existingProgram);
      yield* projectInstructions
        ? Effect.fail(
            CodeSkillRejected.make({
              reason: "not_code_skill",
              detail: `${input.name} is a skill without scripts/run.ts or scripts/run.sh. Choose another name.`,
            }),
          )
        : Effect.void;
      const text = programText(program);
      const scriptSha256 = sha256(text);
      yield* agentSkills.saveCandidate({
        projectId: project.id,
        sessionId,
        name: input.name,
        files: {
          [codeSkillFile(program.runtime)]: text,
          [skillDocumentFile]: skillDocument({ ...input, program }),
        },
      });
      yield* sql`
        INSERT OR IGNORE INTO shell_skill_approvals (project_id, name, script_sha256, approved_at)
        VALUES (${project.id}, ${input.name}, ${scriptSha256},
          ${DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))})`.pipe(
        Effect.when(Effect.succeed(project.permissionMode !== "full")),
      );
      const namesUserFolder = (yield* folderMentions(project, programBody(program).text)).some(
        ({ folder }) => folder === "user",
      );
      const saved = {
        name: input.name,
        scriptSha256,
        replaced: Option.isSome(existingProgram),
        availableTo: savedSkillScope,
        ...optionalProperty("pathNote", namesUserFolder ? cardFolderNote(project) : undefined),
      };
      return Match.value(program).pipe(
        Match.discriminatorsExhaustive("runtime")({
          ts: ({ input: declared }) => ({
            ...saved,
            runtime: "ts" as const,
            input: inputSignature(Option.fromUndefinedOr(declared)),
          }),
          sh: ({ network = [] }) => ({
            ...saved,
            runtime: "sh" as const,
            network: EffectArray.dedupe(network),
          }),
        }),
      );
    }, Effect.provideContext(platform)),

    /**
     * The program `save` would save in place of `program`, or none when it saves it as given; the
     * approval asks about this one (`CallPlan.Rewritten`).
     */
    rewritten: (project: Fenced<Project>, program: SkillProgram) =>
      cardFolderRewritten(project, program).pipe(Effect.provideContext(platform)),

    /** The program to run: refused unless its current content is approved (or the project is `full`). */
    runnable: Effect.fn("CodeSkills.runnable")(function* (
      project: Fenced<Project>,
      sessionId: string | undefined,
      name: string,
    ) {
      const saved = yield* program(project, sessionId, name);
      const allowed =
        project.permissionMode === "full" || (yield* approved(project.id, name, saved.sha256));
      return yield* allowed
        ? Effect.succeed(saved)
        : Effect.fail(
            CodeSkillRejected.make({
              reason: "not_approved",
              detail: `${name}'s program changed since it was approved, or was never approved. Read it, then save it again with save_code_skill so the user can approve this content.`,
            }),
          );
    }, Effect.provideContext(platform)),
  };
});

export class CodeSkills extends Context.Service<CodeSkills, Effect.Success<typeof make>>()(
  "memory-agent/skills/code-skills/CodeSkills",
) {
  static readonly layer = Layer.effect(CodeSkills, make);
}

/** One argument quoted for a POSIX shell. */
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The command line that runs exactly this script text with these arguments. The approved text is
 * passed inline, so an edit after the check cannot change what runs; arguments are never parsed.
 */
export const skillCommand: {
  (text: string, args: readonly string[]): (name: string) => string;
  (name: string, text: string, args: readonly string[]): string;
} = EffectFunction.dual(3, (name: string, text: string, args: readonly string[]) =>
  ["/bin/sh", "-c", text, name, ...args].map(quoted).join(" "),
);
