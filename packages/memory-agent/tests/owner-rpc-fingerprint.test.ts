import { expect, test } from "vite-plus/test";
import {
  ownerRpcFingerprint,
  ownerRpcFrame,
  OwnerRpcFingerprintFailed,
} from "../src/agent/owner-rpc-fingerprint.ts";

const digestOf = (fingerprint: string): string => JSON.parse(fingerprint).digest;

test("digest preserves canonical key ordering and distinguishes the entire request", () => {
  const first = ownerRpcFingerprint("tool", { b: ["한글", -0], a: true });
  const reordered = ownerRpcFingerprint("tool", { a: true, b: ["한글", 0] });
  expect(digestOf(first)).toBe(digestOf(reordered));
  expect(digestOf(first)).not.toBe(
    digestOf(ownerRpcFingerprint("tool", { a: true, b: ["changed", 0] })),
  );
  const nonFinite = () => ownerRpcFingerprint("tool", { number: Number.NaN });
  expect(nonFinite).toThrow(OwnerRpcFingerprintFailed);
  expect(nonFinite).toThrow(expect.objectContaining({ reason: "non_finite" }));
});

test("maximum report read requests keep their whole input", () => {
  const input = ownerRpcFrame({
    name: "get_subagent_reports",
    toolCallId: "read-reports",
    args: {
      attempts: Array.from({ length: 32 }, () => ({
        taskId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        attemptId: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      })),
    },
  });
  const stored = ownerRpcFingerprint("tool", input);
  expect(JSON.parse(stored)).toMatchObject({ inputKind: "complete", input });
});
