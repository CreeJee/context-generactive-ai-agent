import { it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { testRuntime } from "./support/runtime.ts";

const setup = Effect.fnUntraced(function* () {
  const fixture = yield* Effect.promise(() => testRuntime());
  const services = yield* Effect.provideContext(
    Effect.all({ nodes: Nodes, sessions: Sessions, db: Database }),
    yield* fixture.runtime.contextEffect,
  );
  return { ...fixture, ...services };
});

it.effect(
  "first user message names the session without replacing existing or imported titles",
  () =>
    Effect.gen(function* () {
      const { project, session, nodes, sessions } = yield* setup();
      const append = (id: string, text: string) =>
        nodes.append({ projectId: project.id, sessionId: id, kind: "user", text });
      append(session.id, "  첫 질문\n  입니다  ");
      expect((yield* sessions.get(session.id)).title).toBe("첫 질문 입니다");
      append(session.id, "다음 질문");
      expect((yield* sessions.get(session.id)).title).toBe("첫 질문 입니다");
      const named = yield* sessions.create(project.id, "직접 지정");
      append(named.id, "바꾸지 않음");
      expect((yield* sessions.get(named.id)).title).toBe("직접 지정");
      const imported = yield* sessions.createImported(
        project.id,
        null,
        DateTime.formatIso(yield* DateTime.now),
        "codex",
      );
      append(imported.id, "가져온 대화");
      expect((yield* sessions.get(imported.id)).title).toBeNull();
      const long = yield* sessions.create(project.id);
      append(long.id, "😀".repeat(61));
      expect((yield* sessions.get(long.id)).title).toBe("😀".repeat(60) + "…");
      const empty = yield* sessions.create(project.id);
      append(empty.id, "");
      expect((yield* sessions.get(empty.id)).title).toBe("이미지 대화");
    }),
);

it.effect("old untitled conversations show their first message in active and archived lists", () =>
  Effect.gen(function* () {
    const {
      project,
      session,
      nodes,
      sessions,
      db: { sqlite },
    } = yield* setup();
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
    expect((yield* sessions.list(project.id)).find((s) => s.id === session.id)?.title).toBe(
      "첫 번째 질문",
    );
    expect((yield* sessions.get(session.id)).title).toBe("첫 번째 질문");
    expect((yield* sessions.setArchived(session.id, true)).title).toBe("첫 번째 질문");
    expect((yield* sessions.list(project.id, true))[0]?.title).toBe("첫 번째 질문");
    const empty = yield* sessions.create(project.id);
    expect((yield* sessions.get(empty.id)).title).toBeNull();
  }),
);
