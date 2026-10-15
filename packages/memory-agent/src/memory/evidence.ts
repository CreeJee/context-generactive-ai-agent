import { Effect, HashSet, Schema } from "effect";
import { Graph } from "./graph.ts";
import { Interpretations } from "./interpretations.ts";
import { Nodes, type Node } from "./nodes.ts";
import { MemorySearch } from "./search.ts";

export class EvidenceReadFailed extends Schema.TaggedError<EvidenceReadFailed>()(
  "EvidenceReadFailed",
  { reason: Schema.TaggedStruct("StorageRead", {}) },
) {}

/** Recorded changes describe evidence, not independently verified present-day truth. */
type EvidenceAssessment =
  | { readonly kind: "untraced" }
  | { readonly kind: "recorded_change" }
  | { readonly kind: "context_changed" }
  | { readonly kind: "unresolved" }
  | { readonly kind: "no_recorded_change" };

interface Change {
  readonly source: Node;
  readonly targetId: string;
  readonly relation: "corrects" | "retracts";
  readonly status: "applied" | "unconfirmed";
}

const relatedCharacters = 600;
const changeLimit = 8;
const provenanceLimit = 4;

/** Exact excerpts retain UTF-16 source coordinates and a continuation, never a generated summary. */
function excerpt(node: Node) {
  let end = Math.min(node.text.length, relatedCharacters);
  const last = node.text.charCodeAt(end - 1);
  if (end < node.text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return {
    id: node.id,
    kind: node.kind,
    projectId: node.projectId,
    sessionId: node.sessionId,
    recordedAt: node.createdAt,
    detail: node.detail,
    text: node.text.slice(0, end),
    span: { start: 0, end, unit: "utf16" as const },
    nextOffset: end < node.text.length ? end : null,
    length: node.text.length,
  };
}

function assess(id: string, traced: boolean, changes: readonly Change[]): EvidenceAssessment {
  if (!traced) return { kind: "untraced" };
  if (changes.some((change) => change.status === "applied" && change.targetId === id))
    return { kind: "recorded_change" };
  if (changes.some((change) => change.status === "applied")) return { kind: "context_changed" };
  if (changes.length > 0) return { kind: "unresolved" };
  return { kind: "no_recorded_change" };
}

/**
 * Read-time evidence assembly over the owner's existing services. No new retrieval, model call,
 * interpretation or persisted fact. The same scope applies to the root, causes and changes.
 */
export const readStructuredEvidence = Effect.fn("Memory.readStructuredEvidence")(function* (
  id: string,
  offset: number,
  projectId: string,
  crossProject: boolean,
) {
  const nodes = yield* Nodes;
  const graph = yield* Graph;
  const interpretations = yield* Interpretations;
  const search = yield* MemorySearch;

  // These owner services expose synchronous native SQLite reads. Keep their exceptions at this
  // I/O boundary; a failed trace must never be returned as an absence of corrections.
  return yield* Effect.try({
    try: () => {
      const allowed = HashSet.fromIterable(search.allowedProjects(projectId, crossProject));
      const node = nodes.get(id);
      if (node === null || !HashSet.has(allowed, node.projectId)) return null;
      const page = nodes.read(id, offset);
      if (page === null) return null;
      const trace = graph.trace(id);
      // Stop at a scope boundary: filtering out an intermediate cause must not expose a later
      // ancestor or attach that hidden ancestor's corrections to the visible source.
      const chain: Node[] = [];
      for (const cause of trace?.chain ?? []) {
        if (!HashSet.has(allowed, cause.projectId)) break;
        chain.push(cause);
      }
      const eligibleChange = (source: Node, targetId: string) => {
        const target = chain.find((entry) => entry.id === targetId);
        return (
          target !== undefined &&
          source.kind === "user" &&
          source.projectId === target.projectId &&
          source.seq > target.seq &&
          HashSet.has(allowed, source.projectId)
        );
      };
      const changes: Change[] = [];
      for (const change of trace?.challengedBy ?? []) {
        if (eligibleChange(change.node, change.target))
          changes.push({
            source: change.node,
            targetId: change.target,
            relation: change.kind,
            status: "applied",
          });
      }
      for (const pending of interpretations.targeting(
        chain.map((entry) => entry.id),
        "unconfirmed",
      )) {
        switch (pending.kind) {
          case "about":
          case "related":
            continue;
          case "corrects":
          case "retracts": {
            const source = nodes.get(pending.nodeId);
            if (source !== null && eligibleChange(source, pending.targetId))
              changes.push({
                source,
                targetId: pending.targetId,
                relation: pending.kind,
                status: "unconfirmed",
              });
            break;
          }
        }
      }
      // Keep direct applied changes ahead of contextual/pending ones; assess the complete set.
      const priority = (change: Change) =>
        (change.status === "applied" ? 2 : 0) + (change.targetId === id ? 1 : 0);
      changes.sort((a, b) => priority(b) - priority(a) || b.source.seq - a.source.seq);
      const causes = chain.slice(1);
      return {
        ...page,
        projectId: node.projectId,
        sessionId: node.sessionId,
        createdAt: node.createdAt,
        detail: node.detail,
        evidenceContext: {
          assessment: assess(id, trace !== null, changes),
          hasUnconfirmedChanges: changes.some((change) => change.status === "unconfirmed"),
          provenanceScopeLimited: trace !== null && chain.length < trace.chain.length,
          sourceSpan: {
            start: page.offset,
            end: page.offset + page.text.length,
            unit: "utf16" as const,
          },
          provenance: causes.slice(0, provenanceLimit).map(excerpt),
          changes: changes.slice(0, changeLimit).map((change) => ({
            source: excerpt(change.source),
            targetId: change.targetId,
            relation: change.relation,
            status: change.status,
          })),
          omittedChanges: Math.max(0, changes.length - changeLimit),
          omittedProvenance: Math.max(0, causes.length - provenanceLimit),
        },
      };
    },
    catch: () => EvidenceReadFailed.make({ reason: { _tag: "StorageRead" } }),
  });
});
