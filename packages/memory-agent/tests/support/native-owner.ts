import { Effect } from "effect";
import {
  rpcTransport,
  type OwnerConnect,
  type OwnerTransport,
} from "../../src/memory/native-search/client.ts";
import type {
  NativeOwnerFailed,
  OwnerCommand,
  OwnerReply,
} from "../../src/memory/native-search/worker-protocol.ts";

/** The real worker transport, with every command passed through `gate` before it is sent. */
export const gatedTransport =
  (
    gate: (
      command: OwnerCommand,
      transport: OwnerTransport,
    ) => Effect.Effect<OwnerReply, NativeOwnerFailed>,
  ): OwnerConnect =>
  (worker) =>
    Effect.map(rpcTransport(worker), (transport) => ({
      ...transport,
      send: (command) => gate(command, transport),
    }));
