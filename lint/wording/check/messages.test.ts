import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { catalogMessages, sourceMessages } from "./messages.ts";

const catalog = `msgid ""
msgstr ""
"Language: ko\\n"

#: app/entry/a.tsx app/entry/b.tsx
msgid "{count}개를 지웠습니다. <0>되돌리기</0>"
msgstr "{count}개를 지웠습니다. <0>되돌리기</0>"

#: app/entry/c.tsx
msgid "저장했습니다."
msgstr "저장했어요!"

#: app/entry/d.tsx
msgid "Open"
msgstr "Open"

#~ msgid "지난 문구입니다."
#~ msgstr "지난 문구입니다."
`;

describe("catalogMessages", () => {
  it("reads what the app shows, skipping obsolete and non-Korean entries", async () => {
    const messages = await Effect.runPromise(catalogMessages("app/locales/ko.po", catalog));
    expect(messages).toEqual([
      {
        text: "X개를 지웠습니다. 되돌리기",
        where: "app/locales/ko.po (app/entry/a.tsx, app/entry/b.tsx)",
      },
      // The translation, not the source text, is what the screen shows.
      { text: "저장했어요!", where: "app/locales/ko.po (app/entry/c.tsx)" },
    ]);
  });
});

describe("sourceMessages", () => {
  it("reads the messages of every Lingui macro, runtime macro included", async () => {
    const source = [
      'import { t } from "@lingui/core/macro";',
      'import { msg } from "@lingui/core/runtime-macro";',
      "export const a = (name: string) => t`${name}을 열었습니다.`;",
      "export const b = msg`폴더를 찾을 수 없습니다: ${{ cwd: process.cwd() }}`;",
      'export const c = "그대로 둔 문자열";',
    ].join("\n");
    const messages = await Effect.runPromise(sourceMessages("server/a.ts", source));
    expect(messages).toEqual([
      { text: "X을 열었습니다.", where: "server/a.ts:3:37", line: 3, column: 36 },
      { text: "폴더를 찾을 수 없습니다: X", where: "server/a.ts:4:18", line: 4, column: 17 },
    ]);
  });
});
