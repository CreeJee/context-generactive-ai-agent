import { CheckIcon, CopyIcon, FolderIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FieldDescription } from "~/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "~/components/ui/item";
import { ApiError, type Project } from "../api";

export function errorMessage(error: Error) {
  if (!(error instanceof ApiError)) return "설정을 바꾸지 못했어요.";
  switch (error.code) {
    case "keychain_failed":
      return "OS 키체인에 접근하지 못했어요. 키를 다른 곳에 대신 저장하지 않아요.";
    case "kagi_key_required":
      return "먼저 API 키를 등록하세요.";
    default:
      return "설정을 바꾸지 못했어요.";
  }
}

/**
 * The top of every settings page: what it is, the project it applies to when it depends on one,
 * and its main action.
 */
export function PageHeader({
  title,
  badge,
  description,
  project,
  action,
}: {
  title: string;
  badge?: ReactNode;
  description: ReactNode;
  /** Set on pages that read the selected project's files. */
  project?: Project | null;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          {badge}
          {project && (
            <Badge variant="outline">
              <FolderIcon data-icon="inline-start" />
              {project.name}
            </Badge>
          )}
        </div>
        <p className="text-xs/relaxed text-muted-foreground">{description}</p>
      </div>
      {action}
    </header>
  );
}

export function PageError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

export function NoProject() {
  return (
    <FieldDescription>사이드바에서 프로젝트를 고르면 그 프로젝트의 설정이 보여요.</FieldDescription>
  );
}

/** A path as the page shows it: the home folder as `~`, and only its end when it is long. */
export function shortPath(path: string) {
  const fromHome = path
    .replace(/^\/(?:Users|home)\/[^/]+/u, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/u, "~");
  const parts = fromHome.split(/[/\\]/u);
  return parts.length > 5 ? `…/${parts.slice(-3).join("/")}` : fromHome;
}

/** A file of the project named from the project, a file elsewhere by its shortened path. */
export function pathIn(project: Project, path: string) {
  const inside = path.startsWith(`${project.root}/`) || path.startsWith(`${project.root}\\`);
  return inside ? `${project.name}${path.slice(project.root.length)}` : shortPath(path);
}

/** How long the copy button shows that it copied. */
const copiedForMs = 1_500;

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), copiedForMs);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="ghost-muted"
      size="icon-xs"
      aria-label={copied ? "경로를 복사했어요" : "전체 경로 복사"}
      title={path}
      onClick={() =>
        void navigator.clipboard.writeText(path).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

interface SourceFile {
  readonly label: string;
  readonly path: string;
  readonly shown: string;
  readonly error?: string | null;
}

/** Where a page's list comes from, one short line per file; the full path is copied on demand. */
export function SourceFiles({ files, note }: { files: readonly SourceFile[]; note?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      {files.map((file) => (
        <div key={file.label}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="w-12 shrink-0">{file.label}</span>
            <code className="min-w-0 flex-1 truncate" title={file.path}>
              {file.shown}
            </code>
            <CopyPathButton path={file.path} />
          </div>
          {file.error && <p className="whitespace-pre-wrap text-destructive">{file.error}</p>}
        </div>
      ))}
      {note && <p>{note}</p>}
    </div>
  );
}

export const scopeLabels = { global: "공통", project: "프로젝트" } as const;
/** Skills also come built into the app, which MCP servers and agents do not. */
export const skillScopeLabels = { builtin: "기본", ...scopeLabels } as const;

/** One configured MCP server or agent: name, where it is set, how it runs, and what to do. */
export function ConfigEntry({
  icon,
  name,
  scope,
  state,
  target,
  secretKind,
  secretNames,
  problem,
  children,
  actions,
}: {
  icon: ReactNode;
  name: string;
  scope: keyof typeof scopeLabels;
  state: ReactNode;
  target: string;
  secretKind: string;
  secretNames: readonly string[];
  problem: string | null;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Item variant="outline" size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {name}
          <Badge variant="secondary">{scopeLabels[scope]}</Badge>
          {state}
        </ItemTitle>
        <ItemDescription className="break-all">
          <code>{target}</code>
        </ItemDescription>
        {secretNames.length > 0 && (
          <ItemDescription>
            {secretKind}: {secretNames.join(", ")} (값은 보여주지 않아요)
          </ItemDescription>
        )}
        {problem && <ItemDescription variant="destructive">{problem}</ItemDescription>}
        {children}
      </ItemContent>
      {actions && <ItemActions>{actions}</ItemActions>}
    </Item>
  );
}

/** What a trust button says: stop what runs, or trust what does not (again, if it changed). */
export function TrustButton({
  active,
  changed,
  busy,
  onClick,
}: {
  active: boolean;
  changed: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" variant={active ? "ghost" : "outline"} disabled={busy} onClick={onClick}>
      {active ? "사용 중지" : changed ? "다시 신뢰하기" : "신뢰하기"}
    </Button>
  );
}

export const shadowedBadge = <Badge variant="outline">프로젝트 설정으로 대체됨</Badge>;
