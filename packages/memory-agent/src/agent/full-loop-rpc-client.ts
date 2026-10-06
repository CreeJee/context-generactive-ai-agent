// Frozen worker wire adapter is independently snapshotted without the owner Effect runtime.
import type { MessagePort } from "node:worker_threads";
import type { OwnerRpcOperations, OwnerRpcReply, OwnerRpcRequest } from "./owner-rpc.ts";
// Erasable TypeScript only: native Node workers load this without a transpiler.
// Wire-compatible client for the existing validated owner-rpc-transport endpoint.
export function makeOwnerRpcPortClient(port: MessagePort) {
  let nextId = 0;
  let closed = false;
  const pending: Partial<
    Record<
      number,
      {
        resolve: (reply: OwnerRpcReply) => void;
        reject: (error: Error) => void;
        operationId: number;
      }
    >
  > = {};
  function close() {
    if (closed) return;
    closed = true;
    const entries = Object.values(pending);
    for (const key of Object.keys(pending)) delete pending[Number(key)];
    for (const entry of entries) entry?.reject(new Error("Owner port closed; no replay"));
    port.close();
  }
  port.on("close", close);
  port.on("messageerror", close);
  port.on("message", (frame) => {
    const entry =
      Number.isSafeInteger(frame?.requestId) && frame.requestId > 0
        ? pending[frame.requestId]
        : undefined;
    if (
      frame?.type !== "reply" ||
      entry === undefined ||
      frame.reply?.operationId !== entry.operationId ||
      !["succeeded", "pending", "uncertain", "rejected"].includes(frame.reply.type)
    )
      return close();
    delete pending[frame.requestId];
    entry.resolve(frame.reply);
  });
  port.start();
  return {
    close,
    request(request: OwnerRpcRequest<OwnerRpcOperations>): Promise<OwnerRpcReply> {
      if (closed) return Promise.reject(new Error("Owner port closed; no replay"));
      if (nextId === Number.MAX_SAFE_INTEGER) {
        close();
        return Promise.reject(new Error("Request IDs exhausted"));
      }
      const requestId = ++nextId;
      // Native MessagePort callback handshake; close rejects every pending request.
      // @effect-diagnostics-next-line newPromise:off
      return new Promise((resolve, reject) => {
        pending[requestId] = { resolve, reject, operationId: request.operationId };
        try {
          port.postMessage({ type: "request", requestId, request });
        } catch {
          close();
        }
      });
    },
  };
}
