import { Effect } from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
import { inProcessChatApi } from "../../src/testing/chat-api.ts";
import { TestEnv } from "./test-env.ts";

/** A typed client of the chat API, answered in-process by the test's agent. */
export const chatApi = Effect.provideServiceEffect(
  inProcessChatApi,
  AgentChat,
  Effect.flatMap(TestEnv, (env) => env.use(AgentChat)),
);
