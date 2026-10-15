import { Effect, HashSet, Schema } from "effect";
import { Graph, type Provenance } from "./graph.ts";
import { Interpretations } from "./interpretations.ts";
import { Nodes, textWindow, type EvidencePage, type Node } from "./nodes.ts";
import { MemorySearch } from "./search.ts";

const ReadStage = Schema.Literals(["scope", "source", "trace", "pending_changes"]);
type ReadStage = typeof ReadStage.Type;

export class EvidenceReadFailed extends Schema.TaggedError<EvidenceReadFailed>()(
  "EvidenceReadFailed",
  { reason: Schema.TaggedStruct("StorageRead", { stage: ReadStage }) },
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

interface PendingChange {
  readonly source: Node | null;
  readonly targetId: string;
  readonly relation: "corrects" | "retracts";
}

const relatedCharacters = 600;
const changeLimit = 8;
const provenanceLimit = 4;

/**
 * The owner services read native SQLite synchronously. Only those reads are converted here; the
 * exception itself is dropped because it can carry private paths or row contents, so the typed
 * failure keeps just the stage. A failed read is never returned as an absence of corrections.
 */
const storageRead = <A>(stage: ReadStage, read: () => A) =>
  Effect.try({
    try: read,
    catch: () => EvidenceReadFailed.make({ reason: { _tag: "StorageRead", stage } }),
  });

/** Exact excerpts retain UTF-16 source coordinates and a continuation, never a generated summary. */
function excerpt(node: Node) {
  const window = textWindow(node.text, 0, relatedCharacters);
  return {
    id: node.id,
    kind: node.kind,
    projectId: node.projectId,
    sessionId: node.sessionId,
    recordedAt: node.createdAt,
    detail: node.detail,
    text: window.text,
    span: { start: 0, end: window.text.length, unit: "utf16" as const },
    nextOffset: window.nextOffset,
    length: window.length,
  };
}

/**
 * Stop at a scope boundary: filtering out an intermediate cause must not expose a later ancestor
 * or attach that hidden ancestor's corrections to the visible source.
 */
function scopedChain(trace: Provenance | null, allowed: HashSet.HashSet<string>) {
  const chain: Node[] = [];
  for (const cause of trace?.chain ?? []) {
    if (!HashSet.has(allowed, cause.projectId)) break;
    chain.push(cause);
  }
  return chain;
}

/** Only a later user statement in the target's own, visible project can change it. */
function collectChanges(
  id: string,
  chain: readonly Node[],
  trace: Provenance | null,
  pending: readonly PendingChange[],
  allowed: HashSet.HashSet<string>,
) {
  const eligible = (source: Node, targetId: string) => {
    const target = chain.find((entry) => entry.id === targetId);
    return (
      target !== undefined &&
      source.kind === "user" &&
      source.projectId === target.projectId &&
      source.seq > target.seq &&
      HashSet.has(allowed, source.projectId)
    );
  };
  const changes: Change[] = (trace?.challengedBy ?? [])
    .filter((change) => eligible(change.node, change.target))
    .map((change) => ({
      source: change.node,
      targetId: change.target,
      relation: change.kind,
      status: "applied",
    }));
  const appliedAlready = (source: Node, entry: PendingChange) =>
    changes.some(
      (change) =>
        change.source.id === source.id &&
        change.targetId === entry.targetId &&
        change.relation === entry.relation,
    );
  for (const entry of pending) {
    // A question later resolved into an applied relation is no longer unconfirmed.
    if (entry.source === null || !eligible(entry.source, entry.targetId)) continue;
    if (appliedAlready(entry.source, entry)) continue;
    changes.push({
      source: entry.source,
      targetId: entry.targetId,
      relation: entry.relation,
      status: "unconfirmed",
    });
  }
  // Keep direct applied changes ahead of contextual/pending ones; assess the complete set.
  const priority = (change: Change) =>
    (change.status === "applied" ? 2 : 0) + (change.targetId === id ? 1 : 0);
  return changes.sort((a, b) => priority(b) - priority(a) || b.source.seq - a.source.seq);
}

function assess(id: string, traced: boolean, changes: readonly Change[]): EvidenceAssessment {
  if (!traced) return { kind: "untraced" };
  if (changes.some((change) => change.status === "applied" && change.targetId === id))
    return { kind: "recorded_change" };
  if (changes.some((change) => change.status === "applied")) return { kind: "context_changed" };
  if (changes.length > 0) return { kind: "unresolved" };
  return { kind: "no_recorded_change" };
}

function assemble(
  node: Node,
  page: EvidencePage,
  trace: Provenance | null,
  chain: readonly Node[],
  changes: readonly Change[],
) {
  const causes = chain.slice(1);
  return {
    ...page,
    projectId: node.projectId,
    sessionId: node.sessionId,
    createdAt: node.createdAt,
    detail: node.detail,
    evidenceContext: {
      assessment: assess(node.id, trace !== null, changes),
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
}

/**
 * Read-time evidence assembly over the owner's existing services. No new retrieval, model call,
 * interpretation or persisted fact. The same scope applies to the root, causes and changes.
 * A missing or out-of-scope source succeeds with null.
 */
export const readStructuredEvidence = Effect.fn("Memory.readStructuredEvidence")(
  function* (id: string, offset: number, projectId: string, crossProject: boolean) {
    const [nodes, graph, interpretations, search] = yield* Effect.all([
      Nodes,
      Graph,
      Interpretations,
      MemorySearch,
    ]);
    const allowed = yield* storageRead("scope", () =>
      HashSet.fromIterable(search.allowedProjects(projectId, crossProject)),
    );
    const node = yield* storageRead("source", () => nodes.get(id)).pipe(
      Effect.flatMap(Effect.fromNullishOr),
      Effect.filterOrFail((source) => HashSet.has(allowed, source.projectId)),
    );
    const page = yield* storageRead("source", () => nodes.read(id, offset)).pipe(
      Effect.flatMap(Effect.fromNullishOr),
    );
    const trace = yield* storageRead("trace", () => graph.trace(id));
    const chain = scopedChain(trace, allowed);
    const pending = yield* storageRead("pending_changes", () =>
      interpretations
        .targeting(
          chain.map((entry) => entry.id),
          "unconfirmed",
        )
        .flatMap((entry): PendingChange[] => {
          switch (entry.kind) {
            case "about":
            case "related":
              return [];
            case "corrects":
            case "retracts":
              return [
                { source: nodes.get(entry.nodeId), targetId: entry.targetId, relation: entry.kind },
              ];
          }
        }),
    );
    return assemble(node, page, trace, chain, collectChanges(id, chain, trace, pending, allowed));
  },
  Effect.catchTag("NoSuchElementError", () => Effect.succeed(null)),
);
