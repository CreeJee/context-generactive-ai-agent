import { describe, expect, test } from "vite-plus/test";
import { parseSlash, promptOf, suggest, type SlashContext } from "./slash-commands";

const context: SlashContext = {
  agents: ["codex"],
  models: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
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
    expect(parseSlash("그냥 메시지", context)).toEqual({ kind: "not_command" });
    expect(parseSlash("/new", context)).toEqual({ kind: "command", command: { kind: "new" } });
    expect(parseSlash("/mode auto", context)).toEqual({
      kind: "command",
      command: { kind: "mode", mode: "auto" },
    });
    expect(parseSlash("/agent codex", context)).toEqual({
      kind: "command",
      command: { kind: "agent", agent: "codex" },
    });
    expect(parseSlash("/agent claude", context)).toMatchObject({ kind: "incomplete" });
    expect(parseSlash("/mode", context)).toMatchObject({ kind: "incomplete" });
    expect(parseSlash("/recall", context)).toMatchObject({ kind: "incomplete" });
    expect(parseSlash("/goal 결제 실패를 줄이고 싶어", context)).toEqual({
      kind: "command",
      command: {
        kind: "workflow",
        phase: "goal",
        request: "결제 실패를 줄이고 싶어",
      },
    });
    expect(parseSlash("/plan", context)).toEqual({
      kind: "command",
      command: { kind: "workflow", phase: "plan", request: "" },
    });
    expect(parseSlash("/execute", context)).toEqual({
      kind: "command",
      command: { kind: "workflow", phase: "execute", request: "" },
    });
    expect(parseSlash("/status", context)).toEqual({
      kind: "command",
      command: { kind: "workflow_status" },
    });
    // A path is a message, not an unknown command.
    expect(parseSlash("/usr/local/bin 에 뭐가 있어?", context)).toEqual({ kind: "not_command" });

    const skill = parseSlash("/skill review  이 변경을 봐 줘", context);
    expect(skill).toEqual({
      kind: "command",
      command: { kind: "skill", skill: "review", request: "이 변경을 봐 줘" },
    });
    expect(parseSlash("/review 이 변경을 봐 줘", context)).toEqual(skill);
    expect(parseSlash("/Review", context)).toEqual({
      kind: "command",
      command: { kind: "skill", skill: "review", request: "" },
    });
    // The app's command wins over a skill of the same name.
    expect(parseSlash("/new", context)).toEqual({ kind: "command", command: { kind: "new" } });
    expect(parseSlash("/skill new", context)).toEqual({
      kind: "command",
      command: { kind: "skill", skill: "new", request: "" },
    });
    const recall = parseSlash("/recall 로그 포맷", context);
    expect(
      recall.kind === "command" && recall.command.kind === "recall" && promptOf(recall.command),
    ).toContain("로그 포맷");
  });
});
