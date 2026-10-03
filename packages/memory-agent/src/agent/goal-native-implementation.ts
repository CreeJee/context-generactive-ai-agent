// Implementation references, not service constructors: no Layer/resource is acquired here.
// Each middleware factory's native service requirements propagate at per-run binding.
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makeRecordingMiddleware } from "../memory/record.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makePermissionGateMiddleware } from "../permissions/gate.ts";
import { createMemoryTools } from "../tools/memory.ts";
import { createSubscriptionRuntimeImplementation } from "../providers/subscription-runtime.ts";

/** Owner-local code references only. Not a code snapshot or a cold-owner adoption registry:
 * transitive imports/live bindings remain live, and reopening the owner loses this map.
 * Account clients, adapters, middleware and run state must be bound anew by the owner.
 */
export function createGoalNativeImplementations() {
  const goals = new Map<string, ReturnType<typeof capture>>();
  function capture() {
    return Object.freeze({
      createMemoryTools,
      makePermissionGateMiddleware,
      makeRecordingMiddleware,
      openai: createSubscriptionRuntimeImplementation("openai"),
      anthropic: createSubscriptionRuntimeImplementation("anthropic"),
    });
  }
  return {
    adopt(goalInstanceId: string, factories: typeof import("./native-artifact-entry.ts")) {
      if (goals.has(goalInstanceId)) throw new Error("Native Goal implementation already selected");
      goals.set(
        goalInstanceId,
        Object.freeze({
          createMemoryTools: factories.createMemoryTools,
          makePermissionGateMiddleware: factories.makePermissionGateMiddleware,
          makeRecordingMiddleware: factories.makeRecordingMiddleware,
          openai: factories.createSubscriptionRuntimeImplementation("openai"),
          anthropic: factories.createSubscriptionRuntimeImplementation("anthropic"),
        }),
      );
    },
    forGoal(goalInstanceId: string) {
      let implementation = goals.get(goalInstanceId);
      if (!implementation) {
        implementation = capture();
        goals.set(goalInstanceId, implementation);
      }
      return implementation;
    },
  };
}
