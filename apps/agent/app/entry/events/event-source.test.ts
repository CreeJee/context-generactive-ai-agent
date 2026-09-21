import { describe, expect, test, vi } from "vite-plus/test";
import { connectAppEvents } from "./event-source";

class FakeSource {
  readonly listeners = new Map<string, (event: Event) => void>();
  readonly close = vi.fn();
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, data?: string) {
    this.listeners.get(type)?.(
      data === undefined ? new Event(type) : new MessageEvent(type, { data }),
    );
  }
}

describe("connectAppEvents", () => {
  test("decodes events, survives malformed payloads, and closes on abort", () => {
    const source = new FakeSource();
    const changed = vi.fn();
    const malformed = vi.fn();
    const controller = new AbortController();
    connectAppEvents({
      url: () => "/events",
      signal: controller.signal,
      createSource: () => source,
      onReady: vi.fn(),
      onChanged: changed,
      onDecodeError: malformed,
    });
    source.emit("changed", "not-json");
    source.emit(
      "changed",
      JSON.stringify({
        scope: "session",
        projectId: "p1",
        sessionId: "s1",
        topic: "queue",
        revision: 1,
      }),
    );
    expect(malformed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ topic: "queue" }));
    controller.abort();
    expect(source.close).toHaveBeenCalledOnce();
  });
});
