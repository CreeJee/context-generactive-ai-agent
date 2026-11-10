// `@lingui/vite-plugin` compiles a catalog when it is imported.
declare module "*.po" {
  import type { Messages } from "@lingui/core";
  export const messages: Messages;
}
