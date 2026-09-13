import type { Route } from "../+types/_index";
import { chat, chatParamsFromRequest, toServerSentEventsResponse } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}
// https://reactrouter.com/start/framework/actions
export async function action({ request }: Route.ActionArgs) {
  const { messages, threadId, runId } = await chatParamsFromRequest(request);

  const stream = chat({
    adapter: openaiText("gpt-6-astra"),
    messages,
    threadId,
    runId,
  });

  return toServerSentEventsResponse(stream);
}

export default function Agent() {
  return "";
}
