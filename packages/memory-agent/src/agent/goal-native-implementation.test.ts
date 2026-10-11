import { Stream } from "effect";
import { expect, test } from "vite-plus/test";
import type { NormalizedStreamEvent } from "../oauth/protocol.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { createGoalNativeImplementations } from "./goal-native-implementation.ts";

test("owner-local native references are retained by identity, never runtime or account", () => {
  const owner = createGoalNativeImplementations();
  const first = owner.forGoal("goal-a");
  expect(owner.forGoal("goal-a")).toBe(first);
  expect(owner.forGoal("goal-b")).not.toBe(first);
  const selection = { provider: "openai" as const, model: "test-model", reasoningEffort: "low" };
  const acquired: number[] = [];
  const dependencies = (account: number) => ({
    client: () => {
      acquired.push(account);
      return {
        stream: (): AsyncGenerator<NormalizedStreamEvent> =>
          nativeStream(
            Stream.succeed<NormalizedStreamEvent>({ type: "text", text: String(account) }),
          ),
      };
    },
  });
  const a = first.openai.bind(dependencies(1));
  const b = first.openai.bind(dependencies(2));
  expect(a).not.toBe(b);
  expect(a.adapter(selection)).not.toBe(b.adapter(selection));
  expect(acquired).toEqual([1, 2]);
  expect(createGoalNativeImplementations().forGoal("goal-a")).not.toBe(first);
});
