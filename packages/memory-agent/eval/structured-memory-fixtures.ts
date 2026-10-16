import { Effect, Schema } from "effect";
import { Graph } from "../src/memory/graph.ts";
import { Interpretations } from "../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../src/memory/knowledge.ts";
import { Nodes, type Node } from "../src/memory/nodes.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { Sessions } from "../src/sessions/sessions.ts";

export interface EvidenceCase {
  readonly name: string;
  readonly question: string;
  readonly expected: string;
  readonly root: Node;
  readonly sources: readonly Node[];
  readonly support: readonly { readonly id: string; readonly quote: string }[];
  readonly revoked: readonly string[];
}

class EvidenceFixtureFailed extends Schema.TaggedError<EvidenceFixtureFailed>()(
  "EvidenceFixtureFailed",
  { reason: Schema.TaggedStruct("Storage", { cause: Schema.Defect() }) },
) {}

/** Fixed candidates and explicit interpretations isolate reading from retrieval/model extraction. */
export const seedEvidenceCases = Effect.fn("eval.seedEvidenceCases")(function* (projectId: string) {
  const env = {
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
    knowledge: yield* KnowledgePromotions,
    search: yield* MemorySearch,
  };
  const sessions = yield* Sessions;
  const session = yield* sessions.create(projectId);
  return yield* Effect.try({
    try: () => {
      const cases: EvidenceCase[] = [];
      const at = { projectId, sessionId: session.id };
      const user = (text: string) => env.nodes.append({ ...at, kind: "user", text });
      const change = (
        source: Node,
        target: Node,
        kind: "corrects" | "retracts",
        status: "applied" | "unconfirmed" = "applied",
      ) =>
        env.interpretations.record({
          nodeId: source.id,
          targetId: target.id,
          kind,
          status,
          reason: "Synthetic fixture relation",
          model: "fixture",
        });
      const support = (node: Node, quote: string) => ({ id: node.id, quote });

      const region = user("Atlas deployment region is NORTH.");
      const regionChange = user(
        "Correction for Atlas: deployment region is SOUTH. NORTH is retired.",
      );
      change(regionChange, region, "corrects");
      cases.push({
        name: "direct-correction",
        question: "What is Atlas's current deployment region?",
        expected: "SOUTH",
        root: region,
        sources: [region, regionChange],
        support: [support(regionChange, "deployment region is SOUTH")],
        revoked: ["NORTH"],
      });

      const storage = user("Boreal storage mode is LOCAL.");
      const withdrawn = user(
        "Withdraw Boreal's LOCAL storage decision. No replacement storage mode has been approved.",
      );
      change(withdrawn, storage, "retracts");
      cases.push({
        name: "withdrawal",
        question: "What is Boreal's currently approved storage mode?",
        expected: "UNKNOWN",
        root: storage,
        sources: [storage, withdrawn],
        support: [support(withdrawn, "No replacement storage mode has been approved")],
        revoked: ["LOCAL"],
      });

      const scope = user("Cygnus: production cache port is 7412; staging cache port is 7412.");
      const scopedChange = user(
        "Cygnus correction: only staging cache port changes to 8623. Production cache port remains 7412.",
      );
      change(scopedChange, scope, "corrects");
      cases.push({
        name: "conditional-scope",
        question: "What is Cygnus's current production cache port?",
        expected: "7412",
        root: scope,
        sources: [scope, scopedChange],
        support: [support(scopedChange, "Production cache port remains 7412")],
        revoked: [],
      });

      const workers = user("Delta's approved worker limit is 8.");
      const tentative = user(
        "Maybe raise Delta's worker limit to 16. This is only a proposal; do not apply it yet.",
      );
      change(tentative, workers, "corrects", "unconfirmed");
      cases.push({
        name: "unconfirmed-proposal",
        question: "What is Delta's currently approved worker limit?",
        expected: "8",
        root: workers,
        sources: [workers, tentative],
        support: [
          support(workers, "approved worker limit is 8"),
          support(tentative, "do not apply it yet"),
        ],
        revoked: [],
      });

      const initial = user("Echo's initial release channel, approved on October 1, was ALPHA.");
      const later = user(
        "On October 8 Echo's release channel changes to BETA. This supersedes the October 1 ALPHA decision from October 8 onward.",
      );
      change(later, initial, "corrects");
      cases.push({
        name: "historical-question",
        question:
          "What was Echo's approved release channel on October 1, before the October 8 change?",
        expected: "ALPHA",
        root: initial,
        sources: [initial, later],
        support: [support(initial, "approved on October 1, was ALPHA")],
        revoked: [],
      });

      const request = user("Foxtrot: read the staging cache port.");
      const assistant = env.nodes.append({
        ...at,
        kind: "assistant",
        text: "Reading Foxtrot staging.",
        links: [{ kind: "reply", nodeId: request.id }],
      });
      const call = env.nodes.append({
        ...at,
        kind: "tool_call",
        text: "read staging settings",
        links: [{ kind: "calls", nodeId: assistant.id }],
      });
      const observation = env.nodes.append({
        ...at,
        kind: "tool_result",
        text: "Foxtrot staging cache port is 9534.",
        detail: { ok: true },
        links: [{ kind: "returns", nodeId: call.id }],
      });
      const correction = user(
        "Foxtrot correction: I meant production. The production cache port has not been read or recorded yet.",
      );
      change(correction, request, "corrects");
      cases.push({
        name: "changed-ancestor",
        question: "What is Foxtrot's production cache port?",
        expected: "UNKNOWN",
        root: observation,
        sources: [request, assistant, call, observation, correction],
        support: [
          support(observation, "staging cache port is 9534"),
          support(correction, "production cache port has not been read"),
        ],
        revoked: [],
      });

      const longRoot = user("Gemini's active color is AMBER.");
      const longChange = user(
        "Gemini configuration review. " +
          "The audit preserves prior records for historical reference. ".repeat(6) +
          "The approved current color is VIOLET. AMBER is retired.",
      );
      change(longChange, longRoot, "corrects");
      cases.push({
        name: "beyond-legacy-snippet",
        question: "What is Gemini's approved current color?",
        expected: "VIOLET",
        root: longRoot,
        sources: [longRoot, longChange],
        support: [support(longChange, "approved current color is VIOLET")],
        revoked: ["AMBER"],
      });

      const chainRoot = user("Helix's active channel is SILVER.");
      const chainChange = user(
        "Helix's new active channel is GOLD. This retires SILVER; do not revert automatically.",
      );
      change(chainChange, chainRoot, "corrects");
      const chainRetraction = user(
        "Withdraw the Helix GOLD decision. No channel is currently approved; SILVER remains retired.",
      );
      change(chainRetraction, chainChange, "retracts");
      cases.push({
        name: "replacement-later-withdrawn",
        question: "What is Helix's currently approved channel?",
        expected: "UNKNOWN",
        root: chainRoot,
        sources: [chainRoot, chainChange, chainRetraction],
        support: [support(chainRetraction, "No channel is currently approved")],
        revoked: ["SILVER", "GOLD"],
      });

      return { cases, env };
    },
    catch: (cause) => EvidenceFixtureFailed.make({ reason: { _tag: "Storage", cause } }),
  });
});
