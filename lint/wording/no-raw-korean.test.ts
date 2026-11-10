import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { noRawKoreanRule } from "./rules/no-raw-korean.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

tester.run("no-raw-korean", noRawKoreanRule, {
  valid: [
    'const label = "Cancel";',
    "const count = 3;",
    'import { t } from "@lingui/core/macro"; const label = t`취소`;',
    'import { t } from "@lingui/core/macro"; const label = (n: number) => t`${n}개를 지웠습니다.`;',
    'import { msg } from "@lingui/core/macro"; const label = msg({ message: "취소" });',
    'import { Trans } from "@lingui/react/macro"; <Button><Trans>이번만 허용</Trans></Button>;',
    'import { Trans } from "@lingui/react/macro"; <Trans>안녕하세요 <b>{name}</b>님</Trans>;',
    'import { useLingui } from "@lingui/react/macro"; const { t } = useLingui(); t`취소`;',
    { code: 'export const cancel = "취소";', filename: "app/entry/media/copy.ts" },
    { code: 'export const resume = "이어서 진행해 줘.";', filename: "app/entry/chat/prompts.ts" },
    {
      code: 'expect(screen.getByText("취소")).toBeVisible();',
      filename: "app/entry/media/dialog.test.tsx",
    },
    {
      code: 'expect(page.getByText("취소")).toBeVisible();',
      filename: "app/entry/chat/message.browser.tsx",
    },
  ],
  invalid: [
    { code: 'const label = "취소";', errors: [{ messageId: "raw" }] },
    { code: "const label = `프로젝트 ${name}`;", errors: [{ messageId: "raw" }] },
    { code: "<Button>이번만 허용</Button>;", errors: [{ messageId: "raw" }] },
    { code: '<Select aria-label="모델" />;', errors: [{ messageId: "raw" }] },
    // A tag named `t` that is not the Lingui macro is plain code.
    { code: "const t = String.raw; t`취소`;", errors: [{ messageId: "raw" }] },
    {
      code: 'import { Trans } from "@lingui/react/macro"; <Trans>취소</Trans>; const x = "취소";',
      errors: [{ messageId: "raw" }],
    },
    {
      code: 'export const cancel = "취소";',
      filename: "app/entry/media/report-copy.ts",
      errors: [{ messageId: "raw" }],
    },
  ],
});
