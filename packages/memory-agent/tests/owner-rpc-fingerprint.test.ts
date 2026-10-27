import { expect, test } from "vite-plus/test";
import {
  compactLegacyOwnerRpcFingerprint,
  ownerRpcCanonicalJson,
  ownerRpcFingerprint,
  ownerRpcFrame,
  OwnerRpcFingerprintFailed,
} from "../src/agent/owner-rpc-fingerprint.ts";
import { sha256 } from "../src/runtime/synchronous-crypto.ts";

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

test("legacy conversion hashes the original bytes and retains small call inputs", () => {
  const input = ownerRpcFrame({
    name: "get_background_result",
    toolCallId: "read-call",
    args: { taskId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", offset: 0 },
  });
  const legacy = ownerRpcCanonicalJson({ operation: "tool", input });
  const migrated = compactLegacyOwnerRpcFingerprint(legacy);
  expect(digestOf(migrated)).toBe(sha256(legacy));
  expect(JSON.parse(migrated)).toMatchObject({ operation: "tool", input, inputKind: "complete" });
  expect(compactLegacyOwnerRpcFingerprint(migrated)).toBe(migrated);
});

test("large historical snapshots compact without retaining their request tree", () => {
  const legacy = ownerRpcCanonicalJson({
    operation: "middleware",
    input: "history".repeat(150_000),
  });
  const migrated = compactLegacyOwnerRpcFingerprint(legacy);
  expect(migrated.length).toBeLessThan(300);
  expect(digestOf(migrated)).toBe(sha256(legacy));
  expect(JSON.parse(migrated)).toMatchObject({
    operation: "middleware",
    inputKind: "omitted",
    input: null,
  });
  const unsupported = () => compactLegacyOwnerRpcFingerprint("invalid".repeat(5000));
  expect(unsupported).toThrow(OwnerRpcFingerprintFailed);
  expect(unsupported).toThrow(expect.objectContaining({ reason: "unsupported_legacy" }));
});

test("maximum report read requests and envelope overhead stay whole on repeated conversion", () => {
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
  const legacy = ownerRpcCanonicalJson({ operation: "tool", input: "x".repeat(16_340) });
  const migrated = compactLegacyOwnerRpcFingerprint(legacy);
  expect(migrated.length).toBeGreaterThan(16_384);
  expect(compactLegacyOwnerRpcFingerprint(migrated)).toBe(migrated);
  expect(digestOf(migrated)).toBe(sha256(legacy));
});
