import { MutableHashMap, Option } from "effect";
import { describe, expect, test, vi } from "vite-plus/test";
import { connectAppEvents } from "./event-source";

class FakeSource {
  readonly listeners = MutableHashMap.empty<string, (event: Event) => void>();
  readonly close = vi.fn();
  addEventListener(type: string, listener: (event: Event) => void) {
    MutableHashMap.set(this.listeners, type, listener);
  }
  emit(type: string, data?: string) {
    Option.getOrUndefined(MutableHashMap.get(this.listeners, type))?.(
      data === undefined ? new Event(type) : new MessageEvent(type, { data }),
    );
  }
}

describe("connectAppEvents", () => {
  test("decodes events, survives malformed payloads, and closes the source", () => {
    const source = new FakeSource();
    const changed = vi.fn();
    const close = connectAppEvents({
      url: () => "/events",
      createSource: () => source,
      onReady: vi.fn(),
      onChanged: changed,
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
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ topic: "queue" }));
    close();
    expect(source.close).toHaveBeenCalledOnce();
  });
});
