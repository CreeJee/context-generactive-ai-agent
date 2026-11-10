import { describe, expect, it } from "vite-plus/test";
import { backendEnvironment } from "../../scripts/dev-environment.ts";

const vitePlus = "/Users/me/.local/share/vite-plus";

describe("development backend environment", () => {
  it("drops what vp run put first on PATH and keeps the user's own folders", () => {
    const overrides = backendEnvironment("darwin")({
      VP_RUN: "1",
      PATH: [
        "/repo/apps/agent/node_modules/.bin",
        "/repo/node_modules/.bin",
        `${vitePlus}/package_manager/pnpm/12.13.0/pnpm/bin`,
        `${vitePlus}/js_runtime/node/26.12.1/bin`,
        "/Users/me/.local/bin",
        `${vitePlus}/bin`,
        "/project/node_modules/.bin",
        "/usr/bin",
      ].join(":"),
    });
    expect(overrides.PATH).toBe(
      ["/Users/me/.local/bin", `${vitePlus}/bin`, "/project/node_modules/.bin", "/usr/bin"].join(
        ":",
      ),
    );
  });

  it("removes the file-access tracer and the task runner's variables but keeps other preloads", () => {
    const overrides = backendEnvironment("darwin")({
      VP_RUN: "1",
      FSPY: "1",
      PATH: "/usr/bin",
      DYLD_INSERT_LIBRARIES: "/var/folders/x/T/fspy/fspy_preload_1.dylib:/opt/own.dylib",
    });
    expect(overrides).toMatchObject({ FSPY: undefined, VP_RUN: undefined, PATH: "/usr/bin" });
    expect(overrides.DYLD_INSERT_LIBRARIES).toBe("/opt/own.dylib");
    expect(overrides.LD_PRELOAD).toBeUndefined();
  });

  it("changes nothing outside vp run", () => {
    expect(
      backendEnvironment("darwin")({ PATH: "/repo/node_modules/.bin:/usr/bin", FSPY: "1" }),
    ).toEqual({});
  });
});
