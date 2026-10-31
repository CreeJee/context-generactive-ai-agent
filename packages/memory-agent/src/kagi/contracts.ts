import { Schema } from "effect";

/** Whether Kagi can be used, as the settings page shows it. The key itself is never returned. */
export const KagiStatus = Schema.Struct({ keyRegistered: Schema.Boolean, enabled: Schema.Boolean });
export type KagiStatus = typeof KagiStatus.Type;
