import { expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { testRuntime } from "./support/runtime.ts";

test("first user message names the session without replacing existing or imported titles", async () => {
  const { runtime, project, session } = await testRuntime();
  const nodes = await runtime.runPromise(Nodes);
  const sessions = await runtime.runPromise(Sessions);
  const append = (id: string, text: string) =>
    nodes.append({ projectId: project.id, sessionId: id, kind: "user", text });
  append(session.id, "  첫 질문\n  입니다  ");
  expect((await runtime.runPromise(sessions.get(session.id))).title).toBe("첫 질문 입니다");
  append(session.id, "다음 질문");
  expect((await runtime.runPromise(sessions.get(session.id))).title).toBe("첫 질문 입니다");
  const named = await runtime.runPromise(sessions.create(project.id, "직접 지정"));
  append(named.id, "바꾸지 않음");
  expect((await runtime.runPromise(sessions.get(named.id))).title).toBe("직접 지정");
  const imported = await runtime.runPromise(
    sessions.createImported(project.id, null, new Date().toISOString(), "codex"),
  );
  append(imported.id, "가져온 대화");
  expect((await runtime.runPromise(sessions.get(imported.id))).title).toBeNull();
  const long = await runtime.runPromise(sessions.create(project.id));
  append(long.id, "😀".repeat(61));
  expect((await runtime.runPromise(sessions.get(long.id))).title).toBe("😀".repeat(60) + "…");
  const empty = await runtime.runPromise(sessions.create(project.id));
  append(empty.id, "");
  expect((await runtime.runPromise(sessions.get(empty.id))).title).toBe("이미지 대화");
});

test("old untitled conversations show their first message in active and archived lists", async () => {
  const { runtime, project, session } = await testRuntime();
  const nodes = await runtime.runPromise(Nodes);
  const sessions = await runtime.runPromise(Sessions);
  const { sqlite } = await runtime.runPromise(Database);
  nodes.append({
    projectId: project.id,
    sessionId: session.id,
    kind: "user",
    text: "첫 번째 질문",
  });
  nodes.append({
    projectId: project.id,
    sessionId: session.id,
    kind: "user",
    text: "두 번째 질문",
  });
  // Simulate a conversation written before automatic titles existed.
  sqlite.prepare("UPDATE sessions SET title = NULL WHERE id = ?").run(session.id);
  expect(
    (await runtime.runPromise(sessions.list(project.id))).find((s) => s.id === session.id)?.title,
  ).toBe("첫 번째 질문");
  expect((await runtime.runPromise(sessions.get(session.id))).title).toBe("첫 번째 질문");
  expect((await runtime.runPromise(sessions.setArchived(session.id, true))).title).toBe(
    "첫 번째 질문",
  );
  expect((await runtime.runPromise(sessions.list(project.id, true)))[0]?.title).toBe(
    "첫 번째 질문",
  );
  const empty = await runtime.runPromise(sessions.create(project.id));
  expect((await runtime.runPromise(sessions.get(empty.id))).title).toBeNull();
});
