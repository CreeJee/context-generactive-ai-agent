import { Effect, Either, Schema } from "effect";
import { CodexAccount } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/auth";

const Intent = Schema.Struct({ intent: Schema.Literal("login", "cancel", "logout") });

/** GET /api/auth — ChatGPT connection state. Never includes tokens or account details. */
export async function loader() {
  return Response.json(
    await agent.runPromise(Effect.flatMap(CodexAccount, (account) => account.status)),
  );
}

/**
 * POST /api/auth { intent: "login" | "cancel" | "logout" }
 * "login" answers with `authUrl` for the browser to open; the state turns "signed-in" once done.
 */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, Intent);
  if (Either.isLeft(body)) return Response.json({ error: "invalid_intent" }, { status: 400 });
  const { intent } = body.right;
  return Response.json(
    await agent.runPromise(Effect.flatMap(CodexAccount, (account) => account[intent])),
  );
}
