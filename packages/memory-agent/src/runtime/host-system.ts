// Native host boundary: Effect has no service for these operating-system facts (no home folder,
// temporary folder, core count or memory size in effect/dist or @effect/platform-node/dist), so `node:os`
// stays here and callers read them as Effects.
import { arch, availableParallelism, homedir, platform, tmpdir, totalmem } from "node:os";
import { Effect } from "effect";

/** The current user's home folder. */
export const homeDirectory = Effect.sync(() => homedir());

/** The operating system's folder for temporary files (`TMPDIR`, `TEMP`, …). */
export const temporaryDirectory = Effect.sync(() => tmpdir());

/** Physical memory of this machine in bytes. */
export const totalMemory = Effect.sync(() => totalmem());

/** How many CPU cores this process may use. */
export const availableCores = Effect.sync(() => availableParallelism());

/** The operating system and CPU architecture, as `darwin-arm64`. */
export const hostPlatform = Effect.sync(() => `${platform()}-${arch()}`);
