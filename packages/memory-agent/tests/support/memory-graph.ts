import { Effect } from "effect";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { TestEnv } from "./test-env.ts";

/** In a fresh session: user -> assistant -> tool_call -> tool_result, then a later user correction. */
export const conversation = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  const nodes = yield* Nodes;
  const at = { projectId: project.id, sessionId: session.id };
  const runId = `${session.id}:run`;

  const user = yield* nodes.append({ ...at, kind: "user", text: "저장소는 SQLite로 하자" });
  const assistant = yield* nodes.append({
    ...at,
    runId,
    kind: "assistant",
    text: "스키마 파일을 확인할게요.",
    links: [{ kind: "reply", nodeId: user.id }],
  });
  const call = yield* nodes.append({
    ...at,
    runId,
    kind: "tool_call",
    text: 'read_file {"path":"schema.sql"}',
    links: [{ kind: "calls", nodeId: assistant.id }],
    refs: ["schema.sql"],
  });
  const result = yield* nodes.append({
    ...at,
    runId,
    kind: "tool_result",
    text: "CREATE TABLE nodes (...)",
    links: [{ kind: "returns", nodeId: call.id }],
  });
  const correction = yield* nodes.append({ ...at, kind: "user", text: "아니 Postgres로 바꾸자" });
  return { project, session, nodes, user, assistant, call, result, correction };
});
