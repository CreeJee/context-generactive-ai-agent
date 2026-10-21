import { Predicate } from "effect";
import { expect, test } from "vite-plus/test";
import {
  compactLegacyOwnerRpcFingerprint,
  ownerRpcCanonicalJson,
  ownerRpcFingerprint,
  ownerRpcFingerprintDigest,
  OwnerRpcFingerprintFailed,
} from "../src/agent/owner-rpc-fingerprint.ts";
import { encodeFullLoopValue, decodeFullLoopValue } from "../src/agent/full-loop-codec.ts";
import { sha256 } from "../src/runtime/synchronous-crypto.ts";

test("large middleware requests retain a digest and hook evidence without the context", () => {
  const input = encodeFullLoopValue({
    index: 3,
    hook: "onFinish",
    context: { messages: [{ content: "private context".repeat(100_000) }] },
  });
  const stored = ownerRpcFingerprint("middleware", input);
  expect(stored.length).toBeLessThan(512);
  expect(stored).not.toContain("private context");
  const compact = JSON.parse(stored);
  expect(Predicate.isTagged(compact, "OwnerRpcFingerprintV1")).toBe(true);
  expect(compact).toMatchObject({
    operation: "middleware",
    inputKind: "middleware-hook",
    digest: sha256(ownerRpcCanonicalJson({ operation: "middleware", input })),
  });
  expect(decodeFullLoopValue(JSON.parse(stored).input)).toEqual({ index: 3, hook: "onFinish" });
});

test("digest preserves canonical key ordering and distinguishes the entire request", () => {
  const first = ownerRpcFingerprint("tool", { b: ["한글", -0], a: true });
  const reordered = ownerRpcFingerprint("tool", { a: true, b: ["한글", 0] });
  expect(ownerRpcFingerprintDigest(first)).toBe(ownerRpcFingerprintDigest(reordered));
  expect(ownerRpcFingerprintDigest(first)).not.toBe(
    ownerRpcFingerprintDigest(ownerRpcFingerprint("tool", { a: true, b: ["changed", 0] })),
  );
  const nonFinite = () => ownerRpcFingerprint("tool", { number: Number.NaN });
  expect(nonFinite).toThrow(OwnerRpcFingerprintFailed);
  expect(nonFinite).toThrow(expect.objectContaining({ reason: "non_finite" }));
});

test("legacy conversion hashes the original bytes and retains small read recovery inputs", () => {
  const input = encodeFullLoopValue({
    name: "get_background_result",
    toolCallId: "read-call",
    args: { taskId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", offset: 0 },
  });
  const legacy = ownerRpcCanonicalJson({ operation: "tool", input });
  const migrated = compactLegacyOwnerRpcFingerprint(legacy);
  expect(ownerRpcFingerprintDigest(migrated)).toBe(ownerRpcFingerprintDigest(legacy));
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
  expect(ownerRpcFingerprintDigest(migrated)).toBe(sha256(legacy));
  expect(JSON.parse(migrated)).toMatchObject({
    operation: "middleware",
    inputKind: "omitted",
    input: null,
  });
  const unsupported = () => compactLegacyOwnerRpcFingerprint("invalid".repeat(5000));
  expect(unsupported).toThrow(OwnerRpcFingerprintFailed);
  expect(unsupported).toThrow(expect.objectContaining({ reason: "unsupported_legacy" }));
});

test("maximum report recovery requests and envelope overhead remain replayable on repeated conversion", () => {
  const input = encodeFullLoopValue({
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
  expect(ownerRpcFingerprintDigest(migrated)).toBe(sha256(legacy));
});
