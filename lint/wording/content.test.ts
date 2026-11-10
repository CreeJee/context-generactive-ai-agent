import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";

import { contentRule } from "./rules/content.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

// Runs the real worker and Kiwi: the first invalid case loads the model.
tester.run("content", contentRule, {
  valid: [
    'const label = "Cancel";',
    'import { t } from "@lingui/core/macro"; const f = (n: number) => t`${n}개를 지웠습니다.`;',
    'import { Trans } from "@lingui/react/macro"; <Trans>이번만 허용</Trans>;',
    'import { msg } from "@lingui/core/runtime-macro"; msg`Goal을 다시 시작할까요?`;',
  ],
  invalid: [
    {
      code: 'import { msg } from "@lingui/core/runtime-macro";\nmsg`설정을 저장했어요.`;',
      errors: [{ messageId: "violation", line: 2 }],
    },
    {
      code: 'import { Trans } from "@lingui/react/macro";\n<Trans>목표를 지울까요?</Trans>;',
      errors: [{ messageId: "violation", line: 2 }],
    },
  ],
});
