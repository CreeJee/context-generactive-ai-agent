import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

import { Effect } from "effect";

import type { CheckerChannel, CheckReply, CheckRequest } from "../check/worker.ts";

/** How long one file may take, the first Kiwi load and model download included. */
const timeoutMs = 300_000;

interface Checker {
  readonly worker: Worker;
  readonly signal: Int32Array;
  readonly replies: MessagePort;
}

const start = (): Checker => {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const { port1: replies, port2: port } = new MessageChannel();
  const channel: CheckerChannel = { signal, port };
  const worker = new Worker(new URL("../check/worker.ts", import.meta.url), {
    workerData: channel,
    transferList: [port],
  });
  // A lint run ends when its files are done, whatever the worker still holds.
  worker.unref();
  replies.unref();
  return { worker, signal, replies };
};

/** Started on the first file that asks, so a lint run without Lingui messages starts nothing. */
const checker = Effect.runSync(Effect.cached(Effect.sync(start)));

/**
 * Check one file's messages and wait for the answer. A lint rule must answer synchronously, so this
 * blocks the linting thread on `Atomics.wait` while the worker reads the messages and runs Kiwi.
 */
export function checkSource(request: CheckRequest): CheckReply {
  const { worker, signal, replies } = Effect.runSync(checker);
  Atomics.store(signal, 0, 0);
  worker.postMessage(request);
  if (Atomics.wait(signal, 0, 0, timeoutMs) === "timed-out") {
    return { _tag: "Unchecked", reason: `${timeoutMs / 1000}초 안에 답하지 않았습니다` };
  }
  const reply = receiveMessageOnPort(replies);
  if (reply === undefined) return { _tag: "Unchecked", reason: "worker가 답을 남기지 않았습니다" };
  // SAFETY: the worker posts only CheckReply values on this port, one per request.
  return reply.message as CheckReply;
}
