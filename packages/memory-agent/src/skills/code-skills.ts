import { isTruthy } from "../truthy.ts";
import {
  Array as EffectArray,
  Clock,
  Context,
  Data,
  DateTime,
  Effect,
  Function as EffectFunction,
  HashSet,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";
import { resolveProjectPath } from "../files/paths.ts";
import {
  createTextFileEffect,
  deleteTextFileEffect,
  readTextFileEffect,
  replaceTextFileEffect,
} from "../files/text.ts";
import { JsonValue } from "../json.ts";
import type { Project } from "../projects/projects.ts";
import { NetworkHost, type SaveCodeSkillInput } from "../tools/definitions.ts";

/**
 * Project code skills: a ts program that calls the run's tools, or a sh script, the only way the
 * model runs a host command. Each one is a standard skill folder, `.agents/skills/<name>/SKILL.md`
 * with `scripts/run.ts` or `scripts/run.sh`, so it stays listed, readable and usable by other
 * agents. A program runs only while its exact content was approved when it was saved.
 */

export type SkillRuntime = "ts" | "sh";
type SkillProgram = (typeof SaveCodeSkillInput.Type)["program"];

export const codeSkillDirectory = (name: string) => `.agents/skills/${name}`;
const codeSkillScript = (name: string, runtime: SkillRuntime) =>
  `${codeSkillDirectory(name)}/scripts/run.${runtime}`;
const codeSkillDocument = (name: string) => `${codeSkillDirectory(name)}/SKILL.md`;

export class CodeSkillRejected extends Schema.TaggedError<CodeSkillRejected>()(
  "CodeSkillRejected",
  {
    reason: Schema.Literals([
      "builtin_overlap",
      "not_code_skill",
      "network_line",
      "input_line",
      "input_schema",
      "not_found",
      "not_approved",
      "ts_skill",
    ]),
    detail: Schema.String,
  },
) {
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
  script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap((line) => line.split(/;|&&|\|\|/))
    .map((step) => (step.split("|")[0] ?? "").trim().split(/\s+/))
    .map(
      (words) =>
        EffectArray.dropWhile(
          words,
          (word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || HashSet.has(prefixes, word),
        )[0] ?? "",
    )
    .map((program) => program.split("/").at(-1) ?? "")
    .filter((program) => program !== "" && !HashSet.has(setup, program));

/** Refuses a script that only wraps what built-in tools do. */
export const builtinOverlap = (script: string): Option.Option<CodeSkillRejected> => {
  const programs = leadingPrograms(script);
  const tools = programs.map(coveredTool);
  return programs.length > 0 && tools.every(isTruthy)
    ? Option.some(
        CodeSkillRejected.make({
          reason: "builtin_overlap",
          detail: `${[...new Set(programs)].join(", ")} ${programs.length === 1 ? "is" : "are"} covered by ${[...new Set(tools)].join(", ")}. Call those tools directly, or combine them in a ts skill; save a sh skill only for what no built-in tool does (builds, tests, git, package managers, project commands).`,
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
        const hosts = [...new Set(network)];
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
  // The table keeps its name from when every saved skill was a shell script.
  const approved = (projectId: string, name: string, sha256: string) =>
    Effect.map(
      sql`
        SELECT 1 FROM shell_skill_approvals
        WHERE project_id = ${projectId} AND name = ${name} AND script_sha256 = ${sha256}`,
      (rows) => rows.length > 0,
    );

  /** Writes one project file, replacing whatever text is there now. */
  const put = Effect.fn("CodeSkills.put")(function* (root: string, path: string, text: string) {
    const target = yield* resolveProjectPath(root, path, "new-or-file");
    if (target.stats === undefined)
      return yield* createTextFileEffect({ absolute: target.absolute, path, text });
    const current = yield* readTextFileEffect({ absolute: target.absolute, path });
    if (current.text === text) return { sha256: current.sha256, bytes: current.bytes };
    return yield* replaceTextFileEffect({
      absolute: target.absolute,
      path,
      expectedSha256: current.sha256,
      text,
    });
  });

  /** Removes one project file as it is now. */
  const remove = Effect.fn("CodeSkills.remove")(function* (absolute: string, path: string) {
    const current = yield* readTextFileEffect({ absolute, path });
    return yield* deleteTextFileEffect({ absolute, path, expectedSha256: current.sha256 });
  });

  const script = Effect.fn("CodeSkills.script")(function* (
    project: Project,
    name: string,
    runtime: SkillRuntime,
  ) {
    const path = codeSkillScript(name, runtime);
    const target = yield* resolveProjectPath(project.root, path, "file");
    const file = yield* readTextFileEffect({ absolute: target.absolute, path });
    return { text: file.text, sha256: file.sha256 };
  });

  /** The program of a project code skill as it is now: its ts program, or else its sh script. */
  const program = (project: Project, name: string) =>
    script(project, name, "ts").pipe(
      Effect.map(({ text, sha256 }) =>
        SavedProgram.ts({ code: text, sha256, input: programInput(text) }),
      ),
      Effect.catchIf(
        (rejection) =>
          Predicate.isTagged(rejection, "PathRejected") && rejection.reason === "not_found",
        () =>
          Effect.map(script(project, name, "sh"), ({ text, sha256 }) =>
            SavedProgram.sh({ text, sha256, network: scriptNetwork(text) }),
          ),
      ),
      Effect.catchIf(
        (rejection) =>
          Predicate.isTagged(rejection, "PathRejected") && rejection.reason === "not_found",
        () =>
          Effect.fail(
            CodeSkillRejected.make({
              reason: "not_found",
              detail: `${name} has no scripts/run.ts or scripts/run.sh. Save it with save_code_skill first.`,
            }),
          ),
      ),
    );

  return {
    /**
     * Saves (or replaces) a code skill. The call itself was approved under the project's policy,
     * so the saved program counts as approved; `full` mode records nothing, so leaving it asks
     * again. A skill keeps one program: saving it in the other runtime removes the old one.
     */
    save: Effect.fn("CodeSkills.save")(function* (
      project: Project,
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
      const runtime = input.program.runtime;
      const document = codeSkillDocument(input.name);
      const existing = yield* resolveProjectPath(project.root, document, "new-or-file");
      const scriptPath = yield* resolveProjectPath(
        project.root,
        codeSkillScript(input.name, runtime),
        "new-or-file",
      );
      const other = codeSkillScript(input.name, runtime === "ts" ? "sh" : "ts");
      const otherPath = yield* resolveProjectPath(project.root, other, "new-or-file");
      yield* existing.stats !== undefined &&
      scriptPath.stats === undefined &&
      otherPath.stats === undefined
        ? Effect.fail(
            CodeSkillRejected.make({
              reason: "not_code_skill",
              detail: `${input.name} is a skill without scripts/run.ts or scripts/run.sh. Choose another name.`,
            }),
          )
        : Effect.void;
      const written = yield* put(
        project.root,
        codeSkillScript(input.name, runtime),
        programText(input.program),
      );
      yield* otherPath.stats === undefined ? Effect.void : remove(otherPath.absolute, other);
      yield* put(project.root, document, skillDocument(input));
      yield* sql`
        INSERT OR IGNORE INTO shell_skill_approvals (project_id, name, script_sha256, approved_at)
        VALUES (${project.id}, ${input.name}, ${written.sha256},
          ${DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))})`.pipe(
        Effect.when(Effect.succeed(project.permissionMode !== "full")),
      );
      const saved = {
        name: input.name,
        directory: codeSkillDirectory(input.name),
        scriptSha256: written.sha256,
        replaced: existing.stats !== undefined,
      };
      return Match.value(input.program).pipe(
        Match.discriminatorsExhaustive("runtime")({
          ts: ({ input: declared }) => ({
            ...saved,
            runtime: "ts" as const,
            input: inputSignature(Option.fromUndefinedOr(declared)),
          }),
          sh: ({ network = [] }) => ({
            ...saved,
            runtime: "sh" as const,
            network: [...new Set(network)],
          }),
        }),
      );
    }),

    /** The program to run: refused unless its current content is approved (or the project is `full`). */
    runnable: Effect.fn("CodeSkills.runnable")(function* (project: Project, name: string) {
      const saved = yield* program(project, name);
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
    }),
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
