import { FlagIcon } from "lucide-react";

export function reportHref(projectId: string | null, sessionId: string | null): string {
  if (!projectId) return "/report";
  const query = new URLSearchParams({ project: projectId });
  if (sessionId) query.set("session", sessionId);
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
      className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
      aria-label="리포트하기"
      title="리포트하기"
    >
      <FlagIcon aria-hidden="true" className="size-4" />
      <span className="sr-only">리포트하기</span>
    </a>
  );
}
