import { Context, Effect, Layer, Schema } from "effect";
import { Graph } from "../memory/graph.ts";
import { readStructuredEvidence, traceStructuredEvidence } from "../memory/evidence.ts";
import { Interpretations } from "../memory/interpretations.ts";
import { Nodes } from "../memory/nodes.ts";
import { MemorySearch } from "../memory/search.ts";
import { optionalProperty } from "../optional-property.ts";
import { runTool } from "./run-tool.ts";

export const memoryToolNames = [
  "find_memory",
  "read_evidence",
  "read_tool_result",
  "trace_evidence",
] as const;

const findMemoryInput = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "What to look for. Phrase it as you would ask it; wording does not need to match the original.",
  }),
});
const readEvidenceInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Node id from find_memory or trace_evidence." }),
  offset: Schema.optionalKey(
    Schema.Finite.annotate({ description: "nextOffset from the previous page, if any." }),
  ),
});
const readToolResultInput = Schema.Struct({
  id: Schema.NonEmptyString.annotate({
    description: "Recorded tool-result node ID from a result summary in this session.",
  }),
  offset: Schema.Finite.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.withDecodingDefaultTypeKey(Effect.succeed(0)),
  ),
});
const traceEvidenceInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Node id to trace back to its cause." }),
});

const findMemory = {
  name: "find_memory",
  description:
    "Search earlier conversations across allowed projects. supersededBy marks corrections/retractions; latest names where those chains end (read the head before relying on it; heads are interpretations, not user confirmation; branched is an anomaly: read every head and ask the user unless the originals show they cover different facts); ask about unconfirmedChallenges and unconfirmedAfter. degraded names search paths that were skipped (text: exact-word matching ran out of time); search again with fewer, more specific words when the answer depends on them.",
  parameters: findMemoryInput,
} as const;

const readEvidence = {
  name: "read_evidence",
  description:
    "Read an exact original page with evidenceContext: source spans, provenance and recorded corrections/retractions. When find_memory returns matchedSpan, pass its start as offset to read the matching part of a long original. recorded_change flags this source; context_changed flags an ancestor. Check the change's scope before using affected evidence as current. A change source's own changes are not expanded here.",
  parameters: readEvidenceInput,
} as const;

const traceEvidence = {
  name: "trace_evidence",
  description:
    "Follow a memory node back to its cause: tool result -> tool call -> assistant message -> the user turn it answered. Also lists later user corrections/retractions and unconfirmed challenges.",
  parameters: traceEvidenceInput,
} as const;

const readToolResult = {
  name: "read_tool_result",
  description:
    "Read a bounded page of the saved, redacted original result behind a compact tool summary. Only tool results from this project and conversation are accessible; use nextOffset for later pages.",
  parameters: readToolResultInput,
} as const;

const notFound = (id: string) => ({ error: "not_found", id });
/** The conversation a run's memory tools read saved tool results from. */
export interface MemoryToolRunBinding {
  readonly projectId: string;
  readonly sessionId: string;
}

/** Live owner services; their storage and search resources remain owned by their Layers. */
export interface MemoryToolEnvironment {
  readonly search: MemorySearch["Service"];
  readonly nodes: Nodes["Service"];
  readonly graph: Graph["Service"];
  readonly interpretations: Interpretations["Service"];
}

/** Which projects' memory the tools read: those cross recall allows, or only the bound one. */
export type MemoryToolScope = "allowed-projects" | "project";

/** The memory services the tools' calls use. */
type MemoryService = MemorySearch | Nodes | Graph | Interpretations;
const memoryServices = (env: MemoryToolEnvironment): Context.Context<MemoryService> =>
  Context.make(MemorySearch, env.search).pipe(
    Context.add(Nodes, env.nodes),
    Context.add(Graph, env.graph),
    Context.add(Interpretations, env.interpretations),
  );

/** What the read-only memory tools do for one project. */
const memoryReads = (projectId: string, scope: MemoryToolScope | undefined) => {
  // Without a scope the tools read every project cross recall allows.
  const crossProject = scope !== "project";
  return {
    findMemory: ({ query }: typeof findMemoryInput.Type) =>
      Effect.flatMap(MemorySearch, (search) =>
        search.find({ query, projectId, crossProject, rerank: true }),
      ),
    readEvidence: ({ id, offset }: typeof readEvidenceInput.Type) =>
      Effect.map(
        readStructuredEvidence(id, offset ?? 0, projectId, crossProject),
        (evidence) => evidence ?? notFound(id),
      ),
    traceEvidence: ({ id }: typeof traceEvidenceInput.Type) =>
      Effect.map(
        traceStructuredEvidence(id, projectId, crossProject),
        (trace) => trace ?? notFound(id),
      ),
  };
};

/** Runs a call of {@link memoryReads} on these services, keeping the caller's fiber and span. */
const providedBy =
  (context: Context.Context<MemoryService>) =>
  <I, A, E>(call: (input: I) => Effect.Effect<A, E, MemoryService>) =>
  (input: I) =>
    Effect.provideContext(call(input), context);

const readRunTools = (
  calls: ReturnType<typeof memoryReads>,
  provided: ReturnType<typeof providedBy>,
) => [
  runTool({ ...findMemory, handler: provided(calls.findMemory) }),
  runTool({ ...readEvidence, handler: provided(calls.readEvidence) }),
  runTool({ ...traceEvidence, handler: provided(calls.traceEvidence) }),
];

/** The read-only memory tools, with no conversation bound. The calls run on the loop's fiber. */
export const memoryReadRunTools = ({
  env,
  projectId,
  scope,
}: {
  readonly env: MemoryToolEnvironment;
  readonly projectId: string;
  readonly scope?: MemoryToolScope;
}) => readRunTools(memoryReads(projectId, scope), providedBy(memoryServices(env)));

/**
 * The memory tools of one chat run, which also read the conversation's saved tool results. The
 * calls run on the loop's fiber, so their spans nest under the run.
 */
export const memoryRunTools = ({
  env,
  binding,
  scope,
}: {
  readonly env: MemoryToolEnvironment;
  readonly binding: MemoryToolRunBinding;
  readonly scope?: MemoryToolScope;
}) => {
  const provided = providedBy(memoryServices(env));
  const readToolResultPage = ({ id, offset }: typeof readToolResultInput.Type) =>
    Effect.flatMap(Nodes, (nodes) =>
      nodes.readToolResultPage(id, binding.projectId, binding.sessionId, offset),
    ).pipe(Effect.map((page) => page ?? notFound(id)));
  return [
    ...readRunTools(memoryReads(binding.projectId, scope), provided),
    runTool({ ...readToolResult, handler: provided(readToolResultPage) }),
  ];
};

const make = Effect.gen(function* () {
  const env: MemoryToolEnvironment = {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
  };
  return {
    /** {@link memoryRunTools} over the agent's own memory. */
    toolsFor: (binding: MemoryToolRunBinding, scope?: MemoryToolScope) =>
      memoryRunTools({ env, binding, ...optionalProperty("scope", scope) }),
  };
});

export class MemoryTools extends Context.Service<MemoryTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/memory/MemoryTools",
) {
  static readonly layer = Layer.effect(MemoryTools, make);
}
