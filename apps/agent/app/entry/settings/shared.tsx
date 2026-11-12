import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect, Fiber, Function as EffectFunction } from "effect";
import { isTruthy } from "../../truthy.ts";
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
import type { ConfigFileFailureCode, ShownFailure } from "memory-agent/definitions";
import type { ApiError, Project } from "../api";
import { FailureDetails } from "../shared/failure-details";

/** Each page's name, in the tab list and at the top of the page. */
export const pageTitles = {
  web: msg({ message: "웹 검색", comment: "Settings page name: web search through Kagi" }),
  image: msg({ message: "이미지 생성", comment: "Settings page name: image generation" }),
  mcp: msg({ message: "MCP 서버", comment: "Settings page name: configured MCP servers" }),
  agents: msg({
    message: "외부 에이전트",
    comment: "Settings page name: outside ACP agents the conversation may delegate to",
  }),
  conversation: msg({
    message: "긴 대화",
    comment: "Settings page name: when a long conversation starts being summarized",
  }),
  recall: msg({
    message: "기억 범위",
    comment: "Settings page name: which memory a conversation may search beyond its project",
  }),
  imports: msg({
    message: "대화 가져오기",
    comment: "Settings page name: importing other coding agents' conversations into memory",
  }),
  embedding: msg({
    message: "임베딩",
    comment: "Settings page name: where memory search vectors are computed",
  }),
  kanban: msg({
    message: "칸반 실행",
    comment: "Settings page name: running Goals on the kanban board",
  }),
  improvements: msg({
    message: "프로젝트 개선",
    comment: "Settings page name: finding repeated corrections in project history",
  }),
  skills: msg({
    message: "Skills",
    comment: "Settings page name: skill instructions the model reads",
  }),
} as const satisfies Record<string, MessageDescriptor>;

export function errorMessage(error: ApiError | null) {
  if (error === null) return t`설정을 바꾸지 못했습니다.`;
  switch (error.code) {
    case "keychain_failed":
      return t`OS 키체인에 접근하지 못했습니다. 키를 다른 곳에 대신 저장하지 않습니다.`;
    case "kagi_key_required":
      return t`먼저 API 키를 등록해 주십시오.`;
    default:
      return t`설정을 바꾸지 못했습니다.`;
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
  if (!isTruthy(error)) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

export function NoProject() {
  return (
    <FieldDescription>
      <Trans>사이드바에서 프로젝트를 고르면 그 프로젝트의 설정이 보입니다.</Trans>
    </FieldDescription>
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
export const pathIn: {
  (path: string): (project: Project) => ReturnType<typeof pathInBody>;
} & typeof pathInBody = EffectFunction.dual(2, pathInBody);
function pathInBody(project: Project, path: string) {
  const inside = path.startsWith(`${project.root}/`) || path.startsWith(`${project.root}\\`);
  return inside ? `${project.name}${path.slice(project.root.length)}` : shortPath(path);
}

/** How long the copy button shows that it copied. */
const copiedForMs = 1_500;

/** A copy to the clipboard: done (shown for a moment), refused, or not tried yet. */
export type CopyOutcome = "idle" | "copied" | "failed";

/** Copies text and reports the outcome; "copied" goes back to "idle" after a moment. */
export function useClipboardCopy() {
  const [outcome, setOutcome] = useState<CopyOutcome>("idle");
  useEffect(() => {
    if (outcome !== "copied") return;
    const task = Effect.runFork(
      Effect.sleep(copiedForMs).pipe(Effect.andThen(Effect.sync(() => setOutcome("idle")))),
    );
    return () => {
      void Effect.runFork(Fiber.interrupt(task));
    };
  }, [outcome]);
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => setOutcome("copied"),
      () => setOutcome("failed"),
    );
  return { outcome, copy };
}

function CopyPathButton({ path }: { path: string }) {
  const { t } = useLingui();
  const { outcome, copy } = useClipboardCopy();
  const copied = outcome === "copied";
  return (
    <Button
      variant="ghost-muted"
      size="icon-xs"
      aria-label={
        copied
          ? t({
              message: "경로를 복사했습니다",
              comment: "Copy button label right after it copied a path",
            })
          : t({
              message: "전체 경로 복사",
              comment: "Icon button that copies a config file's full path",
            })
      }
      title={path}
      onClick={() => copy(path)}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

interface SourceFile {
  readonly label: string;
  readonly path: string;
  readonly shown: string;
  readonly error?: ShownFailure<ConfigFileFailureCode> | null;
}

/** Why a configured server or agent is not working: the code's wording, the source's text folded. */
export interface ConfigProblem {
  readonly text: string;
  readonly detail: string | null;
}

const configFileFailures = {
  unreadable: msg`파일을 읽지 못했습니다.`,
  invalid_config: msg`설정 형식이 맞지 않아 이 파일을 쓰지 않습니다.`,
  invalid_names: msg`이름은 영문자·숫자·_·-로 1~32자여야 합니다. 맞지 않는 항목은 빼고 씁니다.`,
} satisfies Record<ConfigFileFailureCode, MessageDescriptor>;

/** Where a page's list comes from, one short line per file; the full path is copied on demand. */
export function SourceFiles({ files, note }: { files: readonly SourceFile[]; note?: ReactNode }) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      {files.map((file) => (
        <div key={file.path}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="w-12 shrink-0">{file.label}</span>
            <code className="min-w-0 flex-1 truncate" title={file.path}>
              {file.shown}
            </code>
            <CopyPathButton path={file.path} />
          </div>
          {file.error && (
            <>
              <p className="text-destructive">{t(configFileFailures[file.error.code])}</p>
              <FailureDetails detail={file.error.detail} />
            </>
          )}
        </div>
      ))}
      {note && <p>{note}</p>}
    </div>
  );
}

export const scopeLabels = {
  global: msg({
    message: "공통",
    comment: "Scope badge: set in the user-wide config, shared by every project",
  }),
  project: msg({ message: "프로젝트", comment: "Scope badge: set in this project's config" }),
} as const;
/**
 * Skills also come built into the app, which MCP servers and agents do not, and the app keeps the
 * skills its conversations saved: promoted ones every conversation has, and a conversation's own.
 */
export const skillScopeLabels = {
  builtin: msg({ message: "기본", comment: "Scope badge: a skill built into the app" }),
  ...scopeLabels,
  promoted: msg({
    message: "정식",
    comment:
      "Scope badge: a skill a conversation saved that passed a review, so every conversation of the project can use it",
  }),
  candidate: msg({
    message: "후보",
    comment:
      "Scope badge: a skill one conversation saved; only that conversation can use it until a review passes it",
  }),
} as const;

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
  /** `null` when the server could not check it for secrets. */
  target: string | null;
  secretKind: string;
  secretNames: readonly string[];
  problem: ConfigProblem | null;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useLingui();
  const names = secretNames.join(", ");
  return (
    <Item variant="outline" size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {name}
          <Badge variant="secondary">{t(scopeLabels[scope])}</Badge>
          {state}
        </ItemTitle>
        <ItemDescription className="break-all">
          {target === null ? (
            <Trans>비밀정보 확인에 실패해 명령줄을 숨겼습니다.</Trans>
          ) : (
            <code>{target}</code>
          )}
        </ItemDescription>
        {secretNames.length > 0 && (
          <ItemDescription>
            <Trans comment="{secretKind} is the kind of secret (environment variables or HTTP headers); {names} lists their names">
              {secretKind}: {names} (값은 보여 주지 않습니다)
            </Trans>
          </ItemDescription>
        )}
        {problem && (
          <>
            <ItemDescription variant="destructive">{problem.text}</ItemDescription>
            <FailureDetails detail={problem.detail} />
          </>
        )}
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
    <Button
      size="sm"
      variant={active ? "ghost-muted" : "outline"}
      disabled={busy}
      onClick={onClick}
    >
      {active ? (
        <Trans comment="Button that stops a trusted MCP server or agent from running">
          사용 중지
        </Trans>
      ) : changed ? (
        <Trans comment="Button that trusts an MCP server or agent again after its config changed">
          다시 신뢰하기
        </Trans>
      ) : (
        <Trans comment="Button that trusts an MCP server or agent so it may start">신뢰하기</Trans>
      )}
    </Button>
  );
}

export const shadowedBadge = (
  <Badge variant="outline">
    <Trans comment="Badge on a user-wide entry that a project entry of the same name replaces">
      프로젝트 설정으로 대체됨
    </Trans>
  </Badge>
);
