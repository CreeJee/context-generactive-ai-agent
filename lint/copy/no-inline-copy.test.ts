import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { noInlineCopyRule } from "./rules/no-inline-copy.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

tester.run("no-inline-copy", noInlineCopyRule, {
  valid: [
    'const label = "Cancel";',
    "const count = 3;",
    'import { mediaCopy } from "./copy"; <span>{mediaCopy.cancel}</span>;',
    { code: 'export const cancel = "취소";', filename: "app/entry/media/copy.ts" },
    {
      code: 'expect(screen.getByText("취소")).toBeVisible();',
      filename: "app/entry/media/dialog.test.tsx",
    },
  ],
  invalid: [
    { code: 'const label = "취소";', errors: [{ messageId: "inline" }] },
    { code: "const label = `프로젝트 ${name}`;", errors: [{ messageId: "inline" }] },
    { code: "<Button>이번만 허용</Button>;", errors: [{ messageId: "inline" }] },
    { code: '<Select aria-label="모델" />;', errors: [{ messageId: "inline" }] },
    {
      code: 'export const cancel = "취소";',
      filename: "app/entry/media/report-copy.ts",
      errors: [{ messageId: "inline" }],
    },
  ],
});
