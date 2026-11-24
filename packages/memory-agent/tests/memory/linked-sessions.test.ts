import { Effect, FileSystem } from "effect";
import { expect } from "vite-plus/test";
import {
  LinkedSession,
  LinkedSessions,
  readableSessions,
} from "../../src/memory/linked-sessions.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { MemoryTools } from "../../src/tools/memory.ts";
import { callTool } from "../support/run-tools.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

testAgent()("linked conversations", (it) => {
  it.effect("opens only the conversation the user linked, unless its project is excluded", () =>
    Effect.gen(function* () {
      const { base, project } = yield* TestEnv;
      const projects = yield* Projects;
      const sessions = yield* Sessions;
      const nodes = yield* Nodes;
      const linkedSessions = yield* LinkedSessions;
      const fs = yield* FileSystem.FileSystem;
      const other = yield* projects.add(yield* fs.makeTempDirectory({ directory: base }));
      const target = yield* sessions.create(other.id);
      const asked = yield* nodes.append({
        projectId: other.id,
        sessionId: target.id,
        kind: "user",
        text: "결제 취소가 두 번 나가요",
      });
      const answered = yield* nodes.append({
        projectId: other.id,
        sessionId: target.id,
        kind: "assistant",
        text: "취소 요청이 재시도되며 중복됐습니다.",
      });
      const unlinked = yield* sessions.create(other.id);
      const elsewhere = yield* nodes.append({
        projectId: other.id,
        sessionId: unlinked.id,
        kind: "user",
        text: "다른 대화",
      });
      const at = { projectId: project.id, sessionId: (yield* sessions.create(project.id)).id };
      yield* nodes.append({
        ...at,
        kind: "user",
        // A sentence's last mark is not part of the link; a link to a wrong project names nothing.
        text: `이 대화 봐줘 http://localhost:5173/?project=${other.id}&session=${target.id}. 그리고 http://localhost:5173/?project=${project.id}&session=${unlinked.id}`,
      });

      const linked = yield* linkedSessions.linked(project.id, at.sessionId);
      expect(linked).toEqual([
        LinkedSession.Open({
          link: { projectId: other.id, sessionId: target.id },
          projectName: other.name,
          title: (yield* sessions.get(target.id)).title,
          messages: [
            { id: asked.id, kind: "user", snippet: asked.text },
            { id: answered.id, kind: "assistant", snippet: answered.text },
          ],
          total: 2,
        }),
        LinkedSession.Unknown({ link: { projectId: project.id, sessionId: unlinked.id } }),
      ]);

      // The run reads only its own project, and the linked conversation besides.
      const tools = (yield* MemoryTools).toolsFor(
        at,
        "project",
        Effect.succeed(readableSessions(linked)),
      );
      const read = (id: string) => callTool(tools, "read_evidence", { id });
      expect(yield* read(answered.id)).toMatchObject({ id: answered.id, text: answered.text });
      expect(yield* read(elsewhere.id)).toEqual({ error: "not_found", id: elsewhere.id });

      yield* projects.setCrossRecallExcluded(other.id, true);
      expect(yield* linkedSessions.linked(project.id, at.sessionId)).toContainEqual(
        LinkedSession.Closed({
          link: { projectId: other.id, sessionId: target.id },
          projectName: other.name,
        }),
      );
    }),
  );
});
