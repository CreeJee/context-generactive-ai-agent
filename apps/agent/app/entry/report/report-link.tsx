import { Function as EffectFunction } from "effect";
import { isTruthy } from "../../truthy.ts";

export const reportHref: {
  (sessionId: string | null): (projectId: string | null) => ReturnType<typeof reportHrefBody>;
} & typeof reportHrefBody = EffectFunction.dual(2, reportHrefBody);
function reportHrefBody(projectId: string | null, sessionId: string | null): string {
  if (!isTruthy(projectId)) return "/report";
  const query = new URLSearchParams({ project: projectId });
  if (isTruthy(sessionId)) query.set("session", sessionId);
  return `/report?${query}`;
}
