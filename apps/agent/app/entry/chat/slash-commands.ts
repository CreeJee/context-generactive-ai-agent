import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Data, Function as EffectFunction, Match } from "effect";
import { isTruthy } from "../../truthy.ts";
import type { PermissionMode } from "../api";
import { chatPrompts } from "./prompts";

/** A command typed at the start of the composer, once it is complete. */
export type SlashCommand = Data.TaggedEnum<{
  new: {};
  agent: { readonly agent: string };
  mode: { readonly mode: PermissionMode };
  model: { readonly model: string };
  /** The reasoning effort of the selected model. */
  effort: { readonly effort: string };
  settings: {};
  report: {};
  cancel: {};
  /** Stops sending the model tool output it has already answered from. */
  compact: {};
  /** Selects Goal/Plan input or runs a ready Plan on its board. */
  workflow: {
    readonly move: "goal" | "plan" | "run";
    readonly request: string;
  };
  workflow_status: {};
  /** Sent as a message asking the model to follow one skill. */
  skill: { readonly skill: string; readonly request: string };
  /** Sent as a message asking the model to answer from memory. */
  recall: { readonly question: string };
}>;
export const SlashCommand = Data.taggedEnum<SlashCommand>();

/** Where a command's choices come from. */
type ChoiceSource = "agents" | "modes" | "models" | "efforts" | "skills";

/** What a command's argument may be, so suggestions can offer the right values. */
type Argument = Data.TaggedEnum<{
  none: {};
  choice: { readonly from: ChoiceSource };
  text: { readonly placeholder: MessageDescriptor };
}>;
const Argument = Data.taggedEnum<Argument>();

interface CommandSpec {
  readonly name: string;
  readonly description: MessageDescriptor;
  readonly argument: Argument;
  /** For `skill`: free text after the chosen value. */
  readonly trailingText?: MessageDescriptor;
}

export const commandSpecs: readonly CommandSpec[] = [
  { name: "new", description: msg`이 앱의 모델과 새 대화`, argument: Argument.none() },
  {
    name: "agent",
    description: msg`외부 에이전트와 새 대화`,
    argument: Argument.choice({ from: "agents" }),
  },
  {
    name: "skill",
    description: msg`skill을 따라 요청하기`,
    argument: Argument.choice({ from: "skills" }),
    trailingText: msg({
      message: "요청",
      comment: "Placeholder for the free-text request typed after /skill <name>",
    }),
  },
  {
    name: "recall",
    description: msg`기억에서 찾아 답하기`,
    argument: Argument.text({
      placeholder: msg({
        message: "질문",
        comment: "Placeholder for the question typed after /recall",
      }),
    }),
  },
  { name: "goal", description: msg`결과를 맡기고 자율적으로 진행하기`, argument: Argument.none() },
  { name: "plan", description: msg`변경 없이 조사한 뒤 Plan 만들기`, argument: Argument.none() },
  { name: "execute", description: msg`준비된 Plan 승인하고 실행하기`, argument: Argument.none() },
  { name: "status", description: msg`현재 Goal과 Plan 상태 보기`, argument: Argument.none() },
  {
    name: "mode",
    description: msg`권한 모드 바꾸기`,
    argument: Argument.choice({ from: "modes" }),
  },
  {
    name: "model",
    description: msg`모델 바꾸기`,
    argument: Argument.choice({ from: "models" }),
  },
  {
    name: "effort",
    description: msg`추론 강도 바꾸기`,
    argument: Argument.choice({ from: "efforts" }),
  },
  { name: "settings", description: msg`설정 열기`, argument: Argument.none() },
  {
    name: "report",
    description: msg`독립 문제 제보 화면 열기 (모델 호출 없음)`,
    argument: Argument.none(),
  },
  { name: "cancel", description: msg`답변 멈추기`, argument: Argument.none() },
  { name: "compact", description: msg`이미 답한 도구 출력 비우기`, argument: Argument.none() },
];

export interface SlashContext {
  readonly agents: readonly string[];
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** Efforts of the selected model; none when there is no model or it offers no choice. */
  readonly efforts: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string }>;
}

const modes: ReadonlyArray<{ readonly id: PermissionMode; readonly label: MessageDescriptor }> = [
  {
    id: "ask",
    label: msg({
      message: "매번 묻기",
      comment: "Permission mode 'ask': ask before each tool call",
    }),
  },
  {
    id: "auto",
    label: msg({
      message: "자동 판단",
      comment: "Permission mode 'auto': the app decides which calls need asking",
    }),
  },
];

export interface Suggestion {
  /** A command, a skill run as its own command, or a value for the command being typed. */
  readonly kind: "command" | "skill" | "value";
  /** The composer text after picking it. */
  readonly text: string;
  readonly label: string;
  readonly description: string;
  /** Picking it leaves a command that can run as is. */
  readonly runnable: boolean;
}

function choices(from: ChoiceSource, context: SlashContext) {
  switch (from) {
    case "agents":
      return context.agents.map((agent) => ({ id: agent, label: agent }));
    case "modes":
      return modes.map((mode) => ({ id: mode.id, label: i18n._(mode.label) }));
    case "models":
      return context.models;
    case "efforts":
      return context.efforts;
    case "skills":
      return context.skills.map((skill) => ({ id: skill.name, label: skill.description }));
  }
}

/** Splits `/name rest` into the command word and what follows it. */
function split(draft: string) {
  const match = /^\/(\S*)(\s+([\s\S]*))?$/.exec(draft);
  if (!isTruthy(match)) return null;
  return { word: match[1] ?? "", hasSpace: match[2] !== undefined, rest: match[3] ?? "" };
}

const specNamed = (word: string) =>
  commandSpecs.find((candidate) => candidate.name === word.toLowerCase());

/**
 * A skill typed as its own command, `/<skill> [request]`. A command of the same name wins; that
 * skill is still reachable with `/skill`.
 */
const skillNamed = (word: string, context: SlashContext) =>
  isTruthy(specNamed(word))
    ? undefined
    : context.skills.find((skill) => skill.name.toLowerCase() === word.toLowerCase());

/** Suggestions for the draft, or none when it is not a command being typed. */
export const suggest: {
  (context: SlashContext): (draft: string) => ReturnType<typeof suggestBody>;
} & typeof suggestBody = EffectFunction.dual(2, suggestBody);
function suggestBody(draft: string, context: SlashContext): Suggestion[] {
  const parts = split(draft);
  if (!(parts !== null)) return [];
  if (!parts.hasSpace) {
    const word = parts.word.toLowerCase();
    const commands = commandSpecs
      .filter((spec) => spec.name.startsWith(word))
      .map((spec): Suggestion => ({
        kind: "command",
        text: Argument.$is("none")(spec.argument) ? `/${spec.name}` : `/${spec.name} `,
        label: `/${spec.name}`,
        description: i18n._(spec.description),
        runnable: Argument.$is("none")(spec.argument),
      }));
    const skills = context.skills
      .filter(
        (skill) => skill.name.toLowerCase().startsWith(word) && !isTruthy(specNamed(skill.name)),
      )
      .map((skill): Suggestion => ({
        kind: "skill",
        text: `/${skill.name} `,
        label: `/${skill.name}`,
        description: skill.description,
        runnable: false,
      }));
    return [...commands, ...skills];
  }

  const spec = specNamed(parts.word);
  if (!isTruthy(spec)) return [];
  return Argument.$match(spec.argument, {
    none: (): Suggestion[] => [],
    text: (): Suggestion[] => [],
    choice: ({ from }) => {
      const [value = ""] = parts.rest.split(/\s+/, 1);
      // Once a value is followed by a space, what comes next is free text.
      if (parts.rest.length > value.length) return [];
      const lower = value.toLowerCase();
      return choices(from, context)
        .filter((choice) => choice.id.toLowerCase().startsWith(lower))
        .slice(0, 20)
        .map((choice): Suggestion => ({
          kind: from === "skills" ? "skill" : "value",
          text: isTruthy(spec.trailingText)
            ? `/${spec.name} ${choice.id} `
            : `/${spec.name} ${choice.id}`,
          label: choice.id,
          description: choice.label === choice.id ? i18n._(spec.description) : choice.label,
          runnable: spec.trailingText === undefined,
        }));
    },
  });
}

export type SlashParse = Data.TaggedEnum<{
  not_command: {};
  /** Starts like a command but cannot run yet; the reason is shown to the user. */
  incomplete: { readonly reason: string };
  command: { readonly command: SlashCommand };
}>;
export const SlashParse = Data.taggedEnum<SlashParse>();

/** Reads a complete command from the draft. Text that does not start with `/` is a message. */
export const parseSlash: {
  (context: SlashContext): (draft: string) => ReturnType<typeof parseSlashBody>;
} & typeof parseSlashBody = EffectFunction.dual(2, parseSlashBody);
function parseSlashBody(draft: string, context: SlashContext): SlashParse {
  const parts = split(draft.trim());
  if (!(parts !== null)) return SlashParse.not_command();
  const skill = skillNamed(parts.word, context);
  if (isTruthy(skill))
    return SlashParse.command({
      command: SlashCommand.skill({ skill: skill.name, request: parts.rest.trim() }),
    });
  const spec = specNamed(parts.word);
  // Not one of ours: an ordinary message that happens to start with "/", like a path.
  if (!isTruthy(spec)) return SlashParse.not_command();
  const rest = parts.rest.trim();
  const [value = "", ...others] = rest.split(/\s+/);
  const trailing = rest.slice(value.length).trim();

  const known = (from: ChoiceSource) =>
    choices(from, context).some((choice) => choice.id === value);
  // Whole sentences per command, so each noun gets its own particle.
  const needValue = (choose: string, unknown: (value: string) => string): SlashParse =>
    SlashParse.incomplete({ reason: isTruthy(value) ? unknown(value) : choose });

  switch (spec.name) {
    case "new":
      return SlashParse.command({ command: SlashCommand.new() });
    case "settings":
      return SlashParse.command({ command: SlashCommand.settings() });
    case "report":
      return SlashParse.command({ command: SlashCommand.report() });
    case "cancel":
      return SlashParse.command({ command: SlashCommand.cancel() });
    case "compact":
      return SlashParse.command({ command: SlashCommand.compact() });
    case "goal":
    case "plan":
      return SlashParse.command({
        command: SlashCommand.workflow({ move: spec.name, request: rest }),
      });
    case "execute":
      return SlashParse.command({
        command: SlashCommand.workflow({ move: "run", request: "" }),
      });
    case "status":
      return SlashParse.command({ command: SlashCommand.workflow_status() });
    case "agent":
      return known("agents") && others.length === 0
        ? SlashParse.command({ command: SlashCommand.agent({ agent: value }) })
        : needValue(
            t`신뢰한 에이전트를 골라 주십시오.`,
            (agent) => t`신뢰한 에이전트 목록에 없습니다: ${agent}`,
          );
    case "mode":
      return value === "ask" || value === "auto"
        ? SlashParse.command({ command: SlashCommand.mode({ mode: value }) })
        : needValue(
            t`권한 모드를 골라 주십시오(ask 또는 auto).`,
            (mode) => t`권한 모드는 ask나 auto만 쓸 수 있습니다: ${mode}`,
          );
    case "model":
      return known("models")
        ? SlashParse.command({ command: SlashCommand.model({ model: value }) })
        : needValue(
            t`모델을 골라 주십시오.`,
            (model) => t`쓸 수 있는 모델 목록에 없습니다: ${model}`,
          );
    case "effort":
      if (context.efforts.length === 0)
        return SlashParse.incomplete({ reason: t`선택한 모델은 추론 강도를 고를 수 없습니다.` });
      return known("efforts")
        ? SlashParse.command({ command: SlashCommand.effort({ effort: value }) })
        : needValue(
            t`추론 강도를 골라 주십시오.`,
            (effort) => t`선택한 모델에 없는 추론 강도입니다: ${effort}`,
          );
    case "skill":
      return known("skills")
        ? SlashParse.command({
            command: SlashCommand.skill({ skill: value, request: trailing }),
          })
        : needValue(
            t`skill을 골라 주십시오.`,
            (skillName) => t`쓸 수 있는 skill 목록에 없습니다: ${skillName}`,
          );
    case "recall":
      return isTruthy(rest)
        ? SlashParse.command({ command: SlashCommand.recall({ question: rest }) })
        : SlashParse.incomplete({ reason: t`찾을 내용을 적어 주십시오.` });
    default:
      return SlashParse.incomplete({
        reason: t`모르는 명령입니다: /${ph({ word: parts.word })}`,
      });
  }
}

/** The message a prompt command sends. */
export function promptOf(command: Data.TaggedEnum.Value<SlashCommand, "skill" | "recall">) {
  return Match.valueTags(command, {
    skill: ({ skill, request }) => chatPrompts.skill(skill, request),
    recall: ({ question }) => chatPrompts.recall(question),
  });
}
