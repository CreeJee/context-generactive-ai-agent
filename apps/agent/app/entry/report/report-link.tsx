import { Function as EffectFunction } from "effect";
import { isTruthy } from "../../truthy.ts";
import { FlagIcon } from "lucide-react";
import { reportCopy } from "./copy";

export const reportHref: {
  (sessionId: string | null): (projectId: string | null) => ReturnType<typeof reportHrefBody>;
} & typeof reportHrefBody = EffectFunction.dual(2, reportHrefBody);
function reportHrefBody(projectId: string | null, sessionId: string | null): string {
  if (!isTruthy(projectId)) return "/report";
  const query = new URLSearchParams({ project: projectId });
  if (isTruthy(sessionId)) query.set("session", sessionId);
  return `/report?${query}`;
}

export function ReportLink({
  projectId,
  sessionId,
}: {
  projectId: string | null;
  sessionId: string | null;
}) {
  return (
    <a
      href={reportHref(projectId, sessionId)}
      className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
      aria-label={reportCopy.link.label}
      title={reportCopy.link.label}
    >
      <FlagIcon aria-hidden="true" className="size-3" />
      <span className="sr-only">{reportCopy.link.label}</span>
    </a>
  );
}
