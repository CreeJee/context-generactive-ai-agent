import { describe, expect, test } from "vite-plus/test";
import { responseRequiresBackendRestart } from "./backend-restart.ts";

describe("development backend restart detection", () => {
  test("recognizes both stable-backend rejection responses without consuming the body", async () => {
    for (const error of ["backend_restart_required", "backend_restarting"] as const) {
      const response = Response.json(
        { error },
        { status: error === "backend_restarting" ? 503 : 409 },
      );

      await expect(responseRequiresBackendRestart(response)).resolves.toBe(true);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  test("ignores unrelated and successful responses", async () => {
    await expect(
      responseRequiresBackendRestart(Response.json({ error: "run_in_progress" }, { status: 409 })),
    ).resolves.toBe(false);
    await expect(
      responseRequiresBackendRestart(Response.json({ error: "backend_restart_required" })),
    ).resolves.toBe(false);
  });
});
