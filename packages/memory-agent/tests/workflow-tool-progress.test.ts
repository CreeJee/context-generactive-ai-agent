import { expect, test } from "vite-plus/test";
import { toolProgressFingerprint as fingerprint } from "../src/workflow/tool-progress.ts";

test("successful modifications count but no-op writes and edits do not", () => {
  expect(
    fingerprint("write_file", "{}", { path: "a", sha256: "new", created: true }),
  ).not.toBeNull();
  expect(
    fingerprint("edit_file", '{"expectedSha256":"old"}', { path: "a", sha256: "new" }),
  ).not.toBeNull();
  expect(fingerprint("delete_file", "{}", { path: "a", deleted: true })).not.toBeNull();
  expect(
    fingerprint("write_file", '{"expectedSha256":"same"}', { path: "a", sha256: "same" }),
  ).toBeNull();
  expect(
    fingerprint("edit_file", '{"oldText":"same","newText":"same"}', { sha256: "same" }),
  ).toBeNull();
});

test("failures, refusals and empty results are not substantive progress", () => {
  for (const result of [
    undefined,
    null,
    "",
    {},
    [],
    { error: "failed" },
    { approved: false },
    { exitCode: 1, output: "failed" },
    { exitCode: 0, signal: "SIGTERM" },
  ])
    expect(fingerprint("run_shell", "{}", result)).toBeNull();
  expect(
    fingerprint("run_shell", "{}", { exitCode: 0, output: "passed", signal: null }),
  ).not.toBeNull();
  expect(fingerprint("update_workflow_progress", "{}", { updatedAt: "new" })).toBeNull();
});

test("stable result fingerprints ignore call arguments and volatile pagination/timing", () => {
  expect(fingerprint("list_files", "{}", { files: ["a"], snapshot: "one", durationMs: 1 })).toBe(
    fingerprint("list_files", '{"reason":"again"}', {
      durationMs: 99,
      snapshot: "two",
      files: ["a"],
    }),
  );
  expect(fingerprint("read_file", "{}", { path: "a", content: "one" })).not.toBe(
    fingerprint("read_file", "{}", { path: "a", content: "two" }),
  );
});
