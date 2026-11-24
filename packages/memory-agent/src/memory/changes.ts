import { Array as EffectArray, Function as EffectFunction, HashSet } from "effect";
import type { Provenance } from "./graph.ts";
import type { Node } from "./nodes.ts";

/**
 * Who may correct or retract a statement: only a later user statement in the target's own project.
 * find_memory, trace_evidence and read_evidence all judge changes by this one rule.
 */
export const isChangeAuthority: {
  (target: Node): (source: Node) => boolean;
} & typeof isChangeAuthorityBody = EffectFunction.dual(2, isChangeAuthorityBody);
function isChangeAuthorityBody(source: Node, target: Node) {
  return source.kind === "user" && source.projectId === target.projectId && source.seq > target.seq;
}

/** {@link isChangeAuthority} over two `nodes` row aliases, for queries that filter in SQLite. */
export const changeAuthoritySql: {
  (target: string): (source: string) => string;
} & typeof changeAuthoritySqlBody = EffectFunction.dual(2, changeAuthoritySqlBody);
function changeAuthoritySqlBody(source: string, target: string) {
  return `${source}.kind = 'user' AND ${source}.project_id = ${target}.project_id AND ${source}.seq > ${target}.seq`;
}

/**
 * Stop at a scope boundary: filtering out an intermediate cause must not expose a later ancestor
 * or attach that hidden ancestor's corrections to the visible source.
 */
export const scopedChain: {
  (visible: MemoryScope): (trace: Provenance | null) => Node[];
} & typeof scopedChainBody = EffectFunction.dual(2, scopedChainBody);
function scopedChainBody(trace: Provenance | null, visible: MemoryScope): Node[] {
  return EffectArray.takeWhile(trace?.chain ?? [], inScope(visible));
}

/**
 * What a memory read may show: the nodes of `projects`, and the nodes of `sessions`, the
 * conversations the user linked from projects the read does not otherwise reach.
 */
export interface MemoryScope {
  readonly projects: HashSet.HashSet<string>;
  readonly sessions: HashSet.HashSet<string>;
}

/** Whether `node` is in the scope. */
export const inScope: {
  (scope: MemoryScope): (node: Node) => boolean;
} & typeof inScopeBody = EffectFunction.dual(2, inScopeBody);
function inScopeBody(node: Node, scope: MemoryScope) {
  return (
    HashSet.has(scope.projects, node.projectId) ||
    (node.sessionId !== null && HashSet.has(scope.sessions, node.sessionId))
  );
}
