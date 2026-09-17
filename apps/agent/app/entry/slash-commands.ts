import type { PermissionMode } from "./api";

/** A command typed at the start of the composer, once it is complete. */
export type SlashCommand =
  | { readonly kind: "new" }
  | { readonly kind: "agent"; readonly agent: string }
  | { readonly kind: "mode"; readonly mode: PermissionMode }
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "settings" }
  | { readonly kind: "cancel" }
  /** Sent as a message asking the model to follow one skill. */
  | { readonly kind: "skill"; readonly skill: string; readonly request: string }
  /** Sent as a message asking the model to answer from memory. */
  | { readonly kind: "recall"; readonly question: string };

/** What a command's argument may be, so suggestions can offer the right values. */
type Argument =
  | { readonly kind: "none" }
  | { readonly kind: "choice"; readonly from: "agents" | "modes" | "models" | "skills" }
  | { readonly kind: "text"; readonly placeholder: string };

interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly argument: Argument;
  /** For `skill`: free text after the chosen value. */
  readonly trailingText?: string;
}

export const commandSpecs: readonly CommandSpec[] = [
  { name: "new", description: "이 앱의 모델과 새 대화", argument: { kind: "none" } },
  {
    name: "agent",
    description: "외부 에이전트와 새 대화",
    argument: { kind: "choice", from: "agents" },
  },
  {
    name: "skill",
    description: "skill을 따라 요청하기",
    argument: { kind: "choice", from: "skills" },
    trailingText: "요청",
  },
  {
    name: "recall",
    description: "기억에서 찾아 답하기",
    argument: { kind: "text", placeholder: "질문" },
  },
  { name: "mode", description: "권한 모드 바꾸기", argument: { kind: "choice", from: "modes" } },
  { name: "model", description: "모델 바꾸기", argument: { kind: "choice", from: "models" } },
  { name: "settings", description: "설정 열기", argument: { kind: "none" } },
  { name: "cancel", description: "답변 멈추기", argument: { kind: "none" } },
];

export interface SlashContext {
  readonly agents: readonly string[];
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string }>;
}

const modes: ReadonlyArray<{ readonly id: PermissionMode; readonly label: string }> = [
  { id: "ask", label: "매번 묻기" },
  { id: "auto", label: "자동 판단" },
];

export interface Suggestion {
  /** The composer text after picking it. */
  readonly text: string;
  readonly label: string;
  readonly description: string;
  /** Picking it leaves a command that can run as is. */
  readonly runnable: boolean;
}

function choices(from: "agents" | "modes" | "models" | "skills", context: SlashContext) {
  switch (from) {
    case "agents":
      return context.agents.map((agent) => ({ id: agent, label: agent }));
    case "modes":
      return modes;
    case "models":
      return context.models;
    case "skills":
      return context.skills.map((skill) => ({ id: skill.name, label: skill.description }));
  }
}

/** Splits `/name rest` into the command word and what follows it. */
function split(draft: string) {
  const match = /^\/(\S*)(\s+([\s\S]*))?$/.exec(draft);
  if (!match) return null;
  return { word: match[1] ?? "", hasSpace: match[2] !== undefined, rest: match[3] ?? "" };
}

/** Suggestions for the draft, or none when it is not a command being typed. */
export function suggest(draft: string, context: SlashContext): Suggestion[] {
  const parts = split(draft);
  if (!parts) return [];
  if (!parts.hasSpace)
    return commandSpecs
      .filter((spec) => spec.name.startsWith(parts.word.toLowerCase()))
      .map((spec) => ({
        text: spec.argument.kind === "none" ? `/${spec.name}` : `/${spec.name} `,
        label: `/${spec.name}`,
        description: spec.description,
        runnable: spec.argument.kind === "none",
      }));

  const spec = commandSpecs.find((candidate) => candidate.name === parts.word.toLowerCase());
  if (!spec) return [];
  switch (spec.argument.kind) {
    case "none":
    case "text":
      return [];
    case "choice": {
      const [value = ""] = parts.rest.split(/\s+/, 1);
      // Once a value is followed by a space, what comes next is free text.
      if (parts.rest.length > value.length) return [];
      const lower = value.toLowerCase();
      return choices(spec.argument.from, context)
        .filter((choice) => choice.id.toLowerCase().startsWith(lower))
        .slice(0, 20)
        .map((choice) => ({
          text: spec.trailingText ? `/${spec.name} ${choice.id} ` : `/${spec.name} ${choice.id}`,
          label: choice.id,
          description: choice.label === choice.id ? spec.description : choice.label,
          runnable: spec.trailingText === undefined,
        }));
    }
  }
}

export type SlashParse =
  | { readonly kind: "not_command" }
  /** Starts like a command but cannot run yet; the reason is shown to the user. */
  | { readonly kind: "incomplete"; readonly reason: string }
  | { readonly kind: "command"; readonly command: SlashCommand };

/** Reads a complete command from the draft. Text that does not start with `/` is a message. */
export function parseSlash(draft: string, context: SlashContext): SlashParse {
  const parts = split(draft.trim());
  if (!parts) return { kind: "not_command" };
  const spec = commandSpecs.find((candidate) => candidate.name === parts.word.toLowerCase());
  // Not one of ours: an ordinary message that happens to start with "/", like a path.
  if (!spec) return { kind: "not_command" };
  const rest = parts.rest.trim();
  const [value = "", ...others] = rest.split(/\s+/);
  const trailing = rest.slice(value.length).trim();

  const known = (from: "agents" | "modes" | "models" | "skills") =>
    choices(from, context).some((choice) => choice.id === value);
  // Whole sentences per command, so each noun gets its own particle.
  const needValue = (choose: string, unknown: string): SlashParse => ({
    kind: "incomplete",
    reason: value ? `${unknown}: ${value}` : choose,
  });

  switch (spec.name) {
    case "new":
      return { kind: "command", command: { kind: "new" } };
    case "settings":
      return { kind: "command", command: { kind: "settings" } };
    case "cancel":
      return { kind: "command", command: { kind: "cancel" } };
    case "agent":
      return known("agents") && others.length === 0
        ? { kind: "command", command: { kind: "agent", agent: value } }
        : needValue("신뢰한 에이전트를 골라 주세요.", "신뢰한 에이전트 목록에 없어요");
    case "mode":
      return value === "ask" || value === "auto"
        ? { kind: "command", command: { kind: "mode", mode: value } }
        : needValue(
            "권한 모드를 골라 주세요(ask 또는 auto).",
            "권한 모드는 ask나 auto만 쓸 수 있어요",
          );
    case "model":
      return known("models")
        ? { kind: "command", command: { kind: "model", model: value } }
        : needValue("모델을 골라 주세요.", "쓸 수 있는 모델 목록에 없어요");
    case "skill":
      return known("skills")
        ? { kind: "command", command: { kind: "skill", skill: value, request: trailing } }
        : needValue("skill을 골라 주세요.", "쓸 수 있는 skill 목록에 없어요");
    case "recall":
      return rest
        ? { kind: "command", command: { kind: "recall", question: rest } }
        : { kind: "incomplete", reason: "찾을 내용을 적어 주세요." };
    default:
      return { kind: "incomplete", reason: `모르는 명령이에요: /${parts.word}` };
  }
}

/** The message a prompt command sends. */
export function promptOf(command: Extract<SlashCommand, { kind: "skill" | "recall" }>) {
  switch (command.kind) {
    case "skill":
      return `"${command.skill}" skill을 read_skill로 읽고 그 지침대로 해 주세요.${command.request ? `\n\n${command.request}` : ""}`;
    case "recall":
      return `find_memory로 기억을 찾아서, 출처(프로젝트와 시점)와 나중에 바뀐 결정이 있으면 함께 답해 주세요: ${command.question}`;
  }
}
