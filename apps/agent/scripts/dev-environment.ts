import { Array as Arr, Record, String as Str } from "effect";

/** Variables `vp run` sets for its own task bookkeeping and file-access tracing. */
const taskRunnerVariables = [
  "FSPY",
  "FSPY_PAYLOAD",
  "VP_RUN",
  "VP_RUN_IPC_NAME",
  "VP_RUN_NODE_CLIENT_PATH",
  "VP_PATH_INJECTED_TOOLS",
] as const;

/** Preload variables that may carry `vp run`'s file-access tracer. */
const preloadVariables = ["DYLD_INSERT_LIBRARIES", "LD_PRELOAD"] as const;

/** A folder `vp run` puts first on `PATH`: a package's binaries, or its pinned node or package manager. */
const taskRunnerFolder = (folder: string) => {
  const normalized = folder.replaceAll("\\", "/");
  return (
    normalized.endsWith("/node_modules/.bin") ||
    /\/vite-plus\/(?:js_runtime|package_manager)\//u.test(normalized)
  );
};

/**
 * What the backend's environment drops of what `vp run` added to this repository's task, as
 * overrides for a child process that extends the current environment (`undefined` removes).
 *
 * `vp run` puts the repository's `node_modules/.bin` folders and its pinned node and package
 * manager first on `PATH`, and preloads its file-access tracer. The backend runs commands in the
 * user's projects (dependency installs, skills, git), which must find the user's own tools as
 * their shell does: a project pinning another pnpm version otherwise fails to install offline.
 * Outside `vp run` nothing changes.
 */
export const backendEnvironment =
  (platform: NodeJS.Platform) =>
  (environment: NodeJS.ProcessEnv): Record<string, string | undefined> => {
    if (environment.VP_RUN === undefined) return {};
    const delimiter = platform === "win32" ? ";" : ":";
    const pathKey = platform === "win32" && environment.PATH === undefined ? "Path" : "PATH";
    const path = Arr.dropWhile(
      Str.split(environment[pathKey] ?? "", delimiter),
      taskRunnerFolder,
    ).join(delimiter);
    const preloads = Record.fromEntries(
      preloadVariables.map((name) => {
        const kept = Str.split(environment[name] ?? "", delimiter).filter(
          (library) => library.length > 0 && !library.includes("fspy"),
        );
        return [name, Arr.isArrayNonEmpty(kept) ? kept.join(delimiter) : undefined] as const;
      }),
    );
    return {
      ...Record.fromEntries(taskRunnerVariables.map((name) => [name, undefined] as const)),
      ...preloads,
      [pathKey]: path,
    };
  };
