import { expect, test } from "vite-plus/test";
import { assertFullLoopPortable } from "../src/agent/full-loop-admission-preflight.ts";

test("transport rejects nonportable members without executing getters and accepts plain payloads", () => {
  expect(() => assertFullLoopPortable({ messages: [], context: { visible: true } })).not.toThrow();
  let getters = 0;
  const accessor = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      getters++;
      return "unsafe";
    },
  });
  for (const [value, path] of [
    [{ nested: { fn() {} } }, "turn.nested.fn"],
    [accessor, "turn.secret"],
    [{ collection: new Map() }, "turn.collection"],
    [{ value: NaN }, "turn.value"],
  ] as const) {
    expect(() => assertFullLoopPortable(value)).toThrow(path);
  }
  expect(getters).toBe(0);
  const cycle = {};
  Reflect.set(cycle, "next", cycle);
  expect(() => assertFullLoopPortable(cycle)).toThrow("turn.next");
});
