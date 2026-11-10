import { i18n } from "@lingui/core";
import { messages } from "./locales/ko.po";

// Activated when the module loads, on the server render and in the browser alike, so `t` works
// outside React and `<Trans>` renders the same text on both sides.
i18n.loadAndActivate({ locale: "ko", messages });

export { i18n };
