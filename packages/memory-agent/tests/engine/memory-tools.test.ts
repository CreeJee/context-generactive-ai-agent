import { layer } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { expect } from "vite-plus/test";
import { Graph } from "../../src/memory/graph.ts";
import { Interpretations } from "../../src/memory/interpretations.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import {
  MemoryTools,
  memoryReadRunTools,
  type MemoryToolEnvironment,
} from "../../src/tools/memory.ts";
import type { RunTool } from "../../src/tools/run-tool.ts";
import type { JsonValue } from "../../src/json.ts";
import { callTool } from "../support/run-tools.ts";
import { TestEnv } from "../support/test-env.ts";

const environment = Effect.gen(function* () {
  return {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
  };
});

/** The memory tools, by name, called as the model would. */
const callers = (tools: ReadonlyArray<RunTool>) => {
  const named = (name: string) => (params: JsonValue) => callTool(tools, name, params);
  return {
    find: named("find_memory"),
    read: named("read_evidence"),
    trace: named("trace_evidence"),
  };
};

/** The read-only tools over `env`'s memory of every project cross recall allows. */
const reads = (env: MemoryToolEnvironment, projectId: string) =>
  callers(memoryReadRunTools({ env, projectId }));

/** A second agent over its own storage, beside the block's own. */
class OtherStore extends Context.Service<OtherStore, TestEnv["Service"]>()(
  "memory-agent/tests/engine/memory-tools.test/OtherStore",
) {}

layer(
  Layer.merge(
    TestEnv.layer(),
    Layer.effect(OtherStore, TestEnv).pipe(Layer.provide(TestEnv.layer())),
  ),
  { excludeTestServices: true },
)("memory tools across agents", (it) => {
  it.effect(
    "one pinned implementation reads the supplied native owner services, not the first agent",
    () =>
      Effect.gen(function* () {
        const first = yield* TestEnv;
        const second = yield* OtherStore;
        const envA = yield* environment;
        const envB = yield* second.use(environment);
        const append = (env: typeof envA, fixture: typeof first, text: string) =>
          env.nodes.append({
            projectId: fixture.project.id,
            sessionId: fixture.session.id,
            kind: "user",
            text,
          });
        const a = yield* append(envA, first, "first owner evidence");
        const b = yield* append(envB, second, "second owner evidence");
        const toolsA = reads(envA, first.project.id);
        const toolsB = reads(envB, second.project.id);
        expect(yield* toolsA.read({ id: a.id })).toMatchObject({ text: a.text });
        expect(yield* toolsB.read({ id: b.id })).toMatchObject({ text: b.text });
        expect(yield* toolsB.read({ id: a.id })).toEqual({
          error: "not_found",
          id: a.id,
        });
        expect(yield* toolsA.read({ id: b.id })).toEqual({
          error: "not_found",
          id: b.id,
        });
        const wrapper = yield* second.use(MemoryTools);
        const bound = wrapper.toolsFor({
          projectId: second.project.id,
          sessionId: second.session.id,
        });
        expect(yield* callers(bound).read({ id: b.id })).toMatchObject({ text: b.text });
      }),
  );
});
