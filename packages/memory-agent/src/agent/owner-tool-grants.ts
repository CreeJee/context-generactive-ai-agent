import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import type { StreamChunk } from "@tanstack/ai";
type OwnerToolObservation =
  | StreamChunk
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string };

const Invocation = Schema.Struct({
  name: Schema.String,
  toolCallId: Schema.String,
  args: Schema.Unknown,
});
type Invocation = typeof Invocation.Type;
type Call = {
  name: string;
  raw: string;
  complete: boolean;
  grant?: Invocation;
  used: boolean;
  started: boolean;
};

/** Run-local owner observations only. Nothing supplied by a worker creates a call. */
export function makeOwnerToolGrants() {
  const calls = new Map<string, Call>();
  return {
    observe(chunk: OwnerToolObservation) {
      switch (chunk.type) {
        case "TOOL_CALL_START":
          if (calls.has(chunk.toolCallId)) throw new Error("Duplicate owner tool call ID");
          calls.set(chunk.toolCallId, {
            name: chunk.toolCallName,
            raw: "",
            complete: false,
            used: false,
            started: false,
          });
          break;
        case "TOOL_CALL_ARGS": {
          const call = calls.get(chunk.toolCallId);
          if (!call || call.complete) throw new Error("Invalid owner tool argument stream");
          call.raw += chunk.delta;
          break;
        }
        case "TOOL_CALL_END": {
          const call = calls.get(chunk.toolCallId);
          if (!call || call.complete) throw new Error("Invalid owner tool end");
          call.complete = true;
          break;
        }
      }
    },
    toolCalls() {
      return [...calls]
        .filter(([, call]) => call.complete)
        .map(([id, call]) => ({
          id,
          type: "function" as const,
          function: { name: call.name, arguments: call.raw || "{}" },
        }));
    },
    // Decoded RPC payload is untrusted; the exact Invocation schema below is its boundary.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    observed(input: unknown): Invocation {
      const invocation = Schema.decodeUnknownSync(Invocation, { onExcessProperty: "error" })(input);
      const call = calls.get(invocation.toolCallId);
      if (
        !call?.complete ||
        call.used ||
        call.name !== invocation.name ||
        !isDeepStrictEqual(JSON.parse(call.raw || "{}"), invocation.args)
      )
        throw new Error("Unobserved owner tool invocation");
      return structuredClone(invocation);
    },
    approve(input: Invocation, args: Invocation["args"]) {
      const invocation = Schema.decodeSync(Invocation, { onExcessProperty: "error" })(input);
      const call = calls.get(invocation.toolCallId);
      if (
        !call?.complete ||
        call.grant ||
        call.used ||
        call.name !== invocation.name ||
        !isDeepStrictEqual(JSON.parse(call.raw || "{}"), invocation.args)
      )
        throw new Error("Invalid or duplicate owner tool grant observation");
      // Keep the immutable adapter observation in call.raw/name. Only an owner
      // middleware/schema transform supplies the separately bound execution args.
      call.grant = structuredClone({ ...invocation, args });
    },
    // RPC authorization must reject malformed payloads rather than assume an Invocation.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    validate(input: unknown): boolean {
      try {
        const invocation = Schema.decodeUnknownSync(Invocation, { onExcessProperty: "error" })(
          input,
        );
        const call = calls.get(invocation.toolCallId);
        return !!call?.grant && !call.used && isDeepStrictEqual(call.grant, invocation);
      } catch {
        return false;
      }
    },
    // Guard the implementation boundary with the same exact RPC Invocation decoder.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    start(input: unknown): Invocation {
      const invocation = Schema.decodeUnknownSync(Invocation, { onExcessProperty: "error" })(input);
      const call = calls.get(invocation.toolCallId);
      if (!call?.grant || call.started || !isDeepStrictEqual(call.grant, invocation))
        throw new Error("Invalid or repeated owner tool implementation grant");
      call.started = true;
      return structuredClone(call.grant);
    },
    // Tool RPC consumption decodes untrusted payloads before comparing the owner grant.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    consume(input: unknown): Invocation {
      const invocation = Schema.decodeUnknownSync(Invocation, { onExcessProperty: "error" })(input);
      const call = calls.get(invocation.toolCallId);
      if (!call?.grant || call.used || !isDeepStrictEqual(call.grant, invocation))
        throw new Error("Invalid owner tool grant");
      call.used = true;
      return structuredClone(call.grant);
    },
  };
}
