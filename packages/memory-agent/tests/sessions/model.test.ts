import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { Sessions } from "memory-agent";
import { ModelSelection } from "../../src/providers/contracts.ts";
import { sqlRun } from "../support/sql.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const selection = ModelSelection.members[0].make({
  provider: "openai",
  model: "gpt-6-astra",
  reasoningEffort: "high",
});

testAgent()(function (it) {
  it.effect("a conversation created with a model returns it from get and list", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project } = env;
      const created = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.create(project.id, null, null, selection)),
      );
      expect(created.model).toEqual(selection);
      const fetched = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.get(created.id)),
      );
      expect(fetched.model).toEqual(selection);
      const listed = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.list(project.id)),
      );
      expect(listed.find((session) => session.id === created.id)?.model).toEqual(selection);
    }),
  );

  it.effect("setModel gives a conversation a model and null takes it away", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { session } = env;
      const set = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.setModel(session.id, selection)),
      );
      expect(set.model).toEqual(selection);
      expect(
        (yield* env.use(Effect.flatMap(Sessions, (sessions) => sessions.get(session.id)))).model,
      ).toEqual(selection);
      const cleared = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.setModel(session.id, null)),
      );
      expect(cleared.model).toBeNull();
      expect(
        (yield* env.use(Effect.flatMap(Sessions, (sessions) => sessions.get(session.id)))).model,
      ).toBeNull();
    }),
  );

  it.effect("a stored model that no longer reads counts as none", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, session } = env;
      yield* sqlRun("UPDATE sessions SET model_selection = ? WHERE id = ?", "not json", session.id);
      const fetched = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.get(session.id)),
      );
      expect(fetched.model).toBeNull();
      const listed = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.list(project.id)),
      );
      expect(listed.find((item) => item.id === session.id)?.model).toBeNull();
    }),
  );
});
