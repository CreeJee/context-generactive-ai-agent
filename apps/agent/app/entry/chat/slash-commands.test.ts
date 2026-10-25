import { describe, expect, test } from "vite-plus/test";
import {
  parseSlash,
  promptOf,
  SlashCommand,
  SlashParse,
  suggest,
  type SlashContext,
} from "./slash-commands";

const context: SlashContext = {
  agents: ["codex"],
  models: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  ],
  efforts: [
    { id: "low", label: "추론 low" },
    { id: "high", label: "추론 high (현재)" },
  ],
  skills: [
    { name: "review", description: "변경을 검토" },
    { name: "new", description: "새 문서 틀 만들기" },
  ],
};

describe("slash command suggestions", () => {
  test("offer commands for the typed prefix, then values for their argument", () => {
    expect(suggest("hello", context)).toEqual([]);
    expect(suggest("/", context).map((item) => item.label)).toContain("/recall");
    // Skills are offered as commands of their own, after the app's commands.
    expect(suggest("/re", context)).toEqual([
      expect.objectContaining({
        kind: "command",
        label: "/recall",
        text: "/recall ",
        runnable: false,
      }),
      expect.objectContaining({ kind: "command", label: "/report", runnable: true }),
      expect.objectContaining({
        kind: "skill",
        label: "/review",
        text: "/review ",
        description: "변경을 검토",
      }),
    ]);
    // A skill named like a command is left to `/skill`.
    expect(suggest("/new", context)).toEqual([
      expect.objectContaining({ kind: "command", text: "/new", runnable: true }),
    ]);
    expect(suggest("/model gpt-5.6", context)).toEqual([
      expect.objectContaining({ text: "/model gpt-5.6-luna", runnable: true }),
    ]);
    // A skill takes a request after its name.
    expect(suggest("/skill r", context)).toEqual([
      expect.objectContaining({
        kind: "skill",
        text: "/skill review ",
        description: "변경을 검토",
        runnable: false,
      }),
    ]);
    expect(suggest("/skill review 이 PR", context)).toEqual([]);
  });
});

describe("slash command parsing", () => {
  test("reads complete commands and explains incomplete ones", () => {
    expect(parseSlash("그냥 메시지", context)).toEqual(SlashParse.not_command());
    expect(parseSlash("/report", context)).toEqual(
      SlashParse.command({ command: SlashCommand.report() }),
    );
    expect(suggest("/report", context)[0]).toMatchObject({ runnable: true, label: "/report" });
    expect(parseSlash("/mode auto", context)).toEqual(
      SlashParse.command({ command: SlashCommand.mode({ mode: "auto" }) }),
    );
    expect(parseSlash("/agent codex", context)).toEqual(
      SlashParse.command({ command: SlashCommand.agent({ agent: "codex" }) }),
    );
    expect(SlashParse.$is("incomplete")(parseSlash("/agent claude", context))).toBe(true);
    expect(SlashParse.$is("incomplete")(parseSlash("/mode", context))).toBe(true);
    expect(SlashParse.$is("incomplete")(parseSlash("/recall", context))).toBe(true);
    expect(parseSlash("/effort high", context)).toEqual(
      SlashParse.command({ command: SlashCommand.effort({ effort: "high" }) }),
    );
    expect(SlashParse.$is("incomplete")(parseSlash("/effort max", context))).toBe(true);
    // A model without an effort choice says so rather than asking for a value it cannot take.
    expect(parseSlash("/effort high", { ...context, efforts: [] })).toEqual(
      SlashParse.incomplete({ reason: "선택한 모델은 추론 강도를 고를 수 없어요." }),
    );
    expect(parseSlash("/goal 결제 실패를 줄이고 싶어", context)).toEqual(
      SlashParse.command({
        command: SlashCommand.workflow({ phase: "goal", request: "결제 실패를 줄이고 싶어" }),
      }),
    );
    expect(parseSlash("/plan", context)).toEqual(
      SlashParse.command({ command: SlashCommand.workflow({ phase: "plan", request: "" }) }),
    );
    expect(parseSlash("/execute", context)).toEqual(
      SlashParse.command({ command: SlashCommand.workflow({ phase: "execute", request: "" }) }),
    );
    expect(parseSlash("/status", context)).toEqual(
      SlashParse.command({ command: SlashCommand.workflow_status() }),
    );
    // A path is a message, not an unknown command.
    expect(parseSlash("/usr/local/bin 에 뭐가 있어?", context)).toEqual(SlashParse.not_command());

    const skill = parseSlash("/skill review  이 변경을 봐 줘", context);
    expect(skill).toEqual(
      SlashParse.command({
        command: SlashCommand.skill({ skill: "review", request: "이 변경을 봐 줘" }),
      }),
    );
    expect(parseSlash("/review 이 변경을 봐 줘", context)).toEqual(skill);
    expect(parseSlash("/Review", context)).toEqual(
      SlashParse.command({ command: SlashCommand.skill({ skill: "review", request: "" }) }),
    );
    // The app's command wins over a skill of the same name.
    expect(parseSlash("/new", context)).toEqual(
      SlashParse.command({ command: SlashCommand.new() }),
    );
    expect(parseSlash("/skill new", context)).toEqual(
      SlashParse.command({ command: SlashCommand.skill({ skill: "new", request: "" }) }),
    );
    const recall = parseSlash("/recall 로그 포맷", context);
    expect(
      SlashParse.$is("command")(recall) &&
        SlashCommand.$is("recall")(recall.command) &&
        promptOf(recall.command),
    ).toContain("로그 포맷");
  });
});
