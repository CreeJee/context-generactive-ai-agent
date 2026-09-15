import { describe, expect, test } from "vite-plus/test";
import { parseSlash, promptOf, suggest, type SlashContext } from "./slash-commands";

const context: SlashContext = {
  agents: ["codex"],
  models: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  ],
  skills: [{ name: "review", description: "변경을 검토" }],
};

describe("slash command suggestions", () => {
  test("offer commands for the typed prefix, then values for their argument", () => {
    expect(suggest("hello", context)).toEqual([]);
    expect(suggest("/", context).map((item) => item.label)).toContain("/recall");
    expect(suggest("/re", context)).toEqual([
      expect.objectContaining({ label: "/recall", text: "/recall ", runnable: false }),
    ]);
    expect(suggest("/new", context)).toEqual([
      expect.objectContaining({ text: "/new", runnable: true }),
    ]);
    expect(suggest("/model gpt-5.6", context)).toEqual([
      expect.objectContaining({ text: "/model gpt-5.6-luna", runnable: true }),
    ]);
    // A skill takes a request after its name.
    expect(suggest("/skill r", context)).toEqual([
      expect.objectContaining({
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
    // A path is a message, not an unknown command.
    expect(parseSlash("/usr/local/bin 에 뭐가 있어?", context)).toEqual({ kind: "not_command" });

    const skill = parseSlash("/skill review  이 변경을 봐 줘", context);
    expect(skill).toEqual({
      kind: "command",
      command: { kind: "skill", skill: "review", request: "이 변경을 봐 줘" },
    });
    const recall = parseSlash("/recall 로그 포맷", context);
    expect(
      recall.kind === "command" && recall.command.kind === "recall" && promptOf(recall.command),
    ).toContain("로그 포맷");
  });
});
