import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { makeAppEvents } from "../src/events/app-events.ts";

const readFrames = async (response: Response, count: number) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").filter(Boolean).length < count) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  return text;
};

describe("AppEvents", () => {
  test("closes a stream when its request aborts", async () => {
    const events = Effect.runSync(makeAppEvents);
    const controller = new AbortController();
    const response = events.globalStream(
      new Request("http://local", { signal: controller.signal }),
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    expect((await reader.read()).done).toBe(true);
  });

  test("isolates session, project, and global subscribers", async () => {
    const events = Effect.runSync(makeAppEvents);
    const session = events.sessionStream(
      new Request("http://local", { signal: new AbortController().signal }),
      "s1",
    );
    const project = events.projectStream(
      new Request("http://local", { signal: new AbortController().signal }),
      "p1",
    );

    events.publish({ scope: "session", projectId: "p1", sessionId: "s2", topic: "queue" });
    events.publish({ scope: "session", projectId: "p1", sessionId: "s1", topic: "queue" });
    events.publish({ scope: "project", projectId: "p1", topic: "sessions" });

    const [sessionText, projectText] = await Promise.all([
      readFrames(session, 2),
      readFrames(project, 2),
    ]);
    expect(sessionText).toContain('"sessionId":"s1"');
    expect(sessionText).not.toContain('"sessionId":"s2"');
    expect(projectText).toContain('"scope":"project"');
  });
});
