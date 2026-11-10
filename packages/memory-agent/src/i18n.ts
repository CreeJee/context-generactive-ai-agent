import { setupI18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";

/**
 * Lingui instance for text the server shows: ACP editors, the app's error panels, CLI output.
 * Server code runs without a build step (`node bin/*.ts`, worker files), so it writes messages with
 * `msg` from `@lingui/core/runtime-macro` and resolves them here with `i18n._(…)`. The descriptors
 * carry the Korean text itself, so the instance loads no catalog and compiles each message when it
 * is shown; `src/locales/ko.po` exists for extraction and the wording check.
 */
export const i18n = setupI18n({ locale: "ko", messages: { ko: {} } });

// Development builds of @lingui/core set this already; production ones leave messages uncompiled.
i18n.setMessagesCompiler(compileMessage);
