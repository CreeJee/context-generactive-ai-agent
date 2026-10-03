import type { MessagePort } from "node:worker_threads";
import type { OwnerRpcOperations, OwnerRpcReply, OwnerRpcRequest } from "./owner-rpc.ts";
// Erasable TypeScript only: native Node workers load this without a transpiler.
// Wire-compatible client for the existing validated owner-rpc-transport endpoint.
export function makeOwnerRpcPortClient(port: MessagePort) {
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (reply: OwnerRpcReply) => void;
      reject: (error: Error) => void;
      operationId: number;
    }
  >();
  function close() {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(new Error("Owner port closed; no replay"));
    pending.clear();
    port.close();
  }
  port.on("close", close);
  port.on("messageerror", close);
  port.on("message", (frame) => {
    const entry = pending.get(frame?.requestId);
    if (
      frame?.type !== "reply" ||
      !entry ||
      frame.reply?.operationId !== entry.operationId ||
      !["succeeded", "pending", "uncertain", "rejected"].includes(frame.reply.type)
    )
      return close();
    pending.delete(frame.requestId);
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
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject, operationId: request.operationId });
        try {
          port.postMessage({ type: "request", requestId, request });
        } catch {
          close();
        }
      });
    },
  };
}
