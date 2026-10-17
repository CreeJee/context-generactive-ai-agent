import { Array as EffectArray, Effect, HashSet, Schema } from "effect";
import { isChangeAuthority, scopedChain } from "./changes.ts";
import { Graph, type Provenance } from "./graph.ts";
import { Interpretations, type Interpretation } from "./interpretations.ts";
import { Nodes, textWindow, type EvidencePage, type Node } from "./nodes.ts";
import { MemorySearch } from "./search.ts";

const ReadStage = Schema.Literals([
  "scope",
  "source",
  "trace",
  "pending_changes",
  "change_reasons",
]);
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
  readonly reason: string;
}

interface UnconfirmedChange extends Change {
  readonly status: "unconfirmed";
  readonly reason: string;
}

const relatedCharacters = 600;
const traceSnippetCharacters = 300;
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

/** Projects whose memory this read may show. */
const visibleProjects = Effect.fnUntraced(function* (projectId: string, crossProject: boolean) {
  const search = yield* MemorySearch;
  return yield* storageRead("scope", () =>
    HashSet.fromIterable(search.allowedProjects(projectId, crossProject)),
  );
});

/** The visible chain of a node; an unknown or out-of-scope node fails with NoSuchElementError. */
const visibleTrace = Effect.fnUntraced(function* (id: string, allowed: HashSet.HashSet<string>) {
  const graph = yield* Graph;
  const trace = yield* storageRead("trace", () => graph.trace(id));
  const chain = yield* Effect.succeed(scopedChain(trace, allowed)).pipe(
    Effect.filterOrFail(EffectArray.isReadonlyArrayNonEmpty),
  );
  return { trace, chain };
});

/** Pending corrections/retractions of the chain, with their sources loaded. */
const pendingChanges = Effect.fnUntraced(function* (chain: readonly Node[]) {
  const [nodes, interpretations] = yield* Effect.all([Nodes, Interpretations]);
  return yield* storageRead("pending_changes", () =>
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
              {
                source: nodes.get(entry.nodeId),
                targetId: entry.targetId,
                relation: entry.kind,
                reason: entry.reason,
              },
            ];
        }
      }),
  );
});

/**
 * Applied and still-open changes to the visible chain whose source has authority over its target,
 * in trace order. A question later resolved into an applied relation is no longer unconfirmed.
 */
function collectChanges(
  chain: readonly Node[],
  trace: Provenance | null,
  pending: readonly PendingChange[],
) {
  const hasAuthority = (source: Node, targetId: string) => {
    const target = chain.find((entry) => entry.id === targetId);
    return target !== undefined && isChangeAuthority(source, target);
  };
  const applied: Change[] = (trace?.challengedBy ?? [])
    .filter((change) => hasAuthority(change.node, change.target))
    .map((change) => ({
      source: change.node,
      targetId: change.target,
      relation: change.kind,
      status: "applied",
    }));
  const resolved = (source: Node, entry: PendingChange) =>
    applied.some(
      (change) =>
        change.source.id === source.id &&
        change.targetId === entry.targetId &&
        change.relation === entry.relation,
    );
  const unconfirmed = pending.flatMap((entry): UnconfirmedChange[] =>
    entry.source === null ||
    !hasAuthority(entry.source, entry.targetId) ||
    resolved(entry.source, entry)
      ? []
      : [
          {
            source: entry.source,
            targetId: entry.targetId,
            relation: entry.relation,
            status: "unconfirmed",
            reason: entry.reason,
          },
        ],
  );
  return { applied, unconfirmed };
}

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
  found: readonly Change[],
) {
  // Keep direct applied changes ahead of contextual/pending ones; assess the complete set.
  const priority = (change: Change) =>
    (change.status === "applied" ? 2 : 0) + (change.targetId === node.id ? 1 : 0);
  const changes = [...found].sort(
    (a, b) => priority(b) - priority(a) || b.source.seq - a.source.seq,
  );
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

function summary(node: Node) {
  return {
    id: node.id,
    kind: node.kind,
    projectId: node.projectId,
    createdAt: node.createdAt,
    snippet: node.text.slice(0, traceSnippetCharacters),
    detail: node.detail,
  };
}

function summarizeTrace(
  chain: readonly Node[],
  changes: ReturnType<typeof collectChanges>,
  reasons: readonly Interpretation[],
) {
  const reasonFor = (change: Change) =>
    reasons.find(
      (entry) =>
        entry.nodeId === change.source.id &&
        entry.targetId === change.targetId &&
        entry.kind === change.relation,
    )?.reason ?? null;
  return {
    chain: chain.map(summary),
    challengedBy: changes.applied.map((change) => ({
      ...summary(change.source),
      relation: change.relation,
      target: change.targetId,
      reason: reasonFor(change),
    })),
    unconfirmed: changes.unconfirmed.map((change) => ({
      ...summary(change.source),
      possibleRelation: change.relation,
      target: change.targetId,
      reason: change.reason,
    })),
  };
}

/**
 * Read-time evidence assembly over the owner's existing services. No new retrieval, model call,
 * interpretation or persisted fact. The same scope applies to the root, causes and changes.
 * A missing or out-of-scope source succeeds with null.
 */
export const readStructuredEvidence = Effect.fn("Memory.readStructuredEvidence")(
  function* (id: string, offset: number, projectId: string, crossProject: boolean) {
    const nodes = yield* Nodes;
    const allowed = yield* visibleProjects(projectId, crossProject);
    const node = yield* storageRead("source", () => nodes.get(id)).pipe(
      Effect.flatMap(Effect.fromNullishOr),
      Effect.filterOrFail((source) => HashSet.has(allowed, source.projectId)),
    );
    const page = yield* storageRead("source", () => nodes.page(node, offset));
    // A visible source whose provenance cannot be traced is still evidence, reported as untraced.
    const { trace, chain } = yield* visibleTrace(id, allowed).pipe(
      Effect.catchTag("NoSuchElementError", () =>
        Effect.succeed({ trace: null, chain: EffectArray.empty<Node>() }),
      ),
    );
    const changes = collectChanges(chain, trace, yield* pendingChanges(chain));
    return assemble(node, page, trace, chain, [...changes.applied, ...changes.unconfirmed]);
  },
  Effect.catchTag("NoSuchElementError", () => Effect.succeed(null)),
);

/**
 * Provenance and changes of a node under the same scope and authority rules as read_evidence.
 * A missing or out-of-scope node succeeds with null.
 */
export const traceStructuredEvidence = Effect.fn("Memory.traceStructuredEvidence")(
  function* (id: string, projectId: string, crossProject: boolean) {
    const interpretations = yield* Interpretations;
    const allowed = yield* visibleProjects(projectId, crossProject);
    const { trace, chain } = yield* visibleTrace(id, allowed);
    const [pending, reasons] = yield* Effect.all([
      pendingChanges(chain),
      storageRead("change_reasons", () =>
        interpretations.targeting(
          chain.map((entry) => entry.id),
          "applied",
        ),
      ),
    ]);
    return summarizeTrace(chain, collectChanges(chain, trace, pending), reasons);
  },
  Effect.catchTag("NoSuchElementError", () => Effect.succeed(null)),
);
