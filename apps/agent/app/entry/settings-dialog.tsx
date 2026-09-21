import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  CpuIcon,
  FolderIcon,
  GlobeIcon,
  HistoryIcon,
  ImageIcon,
  KeyRoundIcon,
  PlugIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { Schema } from "effect";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { AnimatedNumber } from "~/components/ui/animated-number";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "~/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { dayAndTime, timeOfDay } from "~/lib/dates";
import {
  ApiError,
  api,
  type CrossProviderMediaConsentMode,
  type ExternalAgentView,
  type EmbeddingChoice,
  type EmbeddingOverview,
  type ExternalAgentsOverview,
  type GpuState,
  type ImportActivity,
  type ImageSettingsView,
  type KagiStatus,
  type McpOverview,
  type McpServerView,
  type Project,
  type SkillCatalog,
} from "./api";
import { appQueryKeys } from "./events/query-keys";

const kagiErrors = new Map([
  ["keychain_failed", "OS 키체인에 접근하지 못했어요. 키를 다른 곳에 대신 저장하지 않아요."],
  ["kagi_key_required", "먼저 API 키를 등록하세요."],
]);

const errorMessage = (error: Error) =>
  (error instanceof ApiError && kagiErrors.get(error.code)) || "설정을 바꾸지 못했어요.";

/**
 * The top of every settings page: what it is, the project it applies to when it depends on one,
 * and its main action.
 */
function PageHeader({
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

/** A page's body while it loads, or when loading failed. */
function PageLoading({ error }: { error: string | null }) {
  return error ? <FieldError>{error}</FieldError> : <Spinner />;
}

function PageError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

function NoProject() {
  return (
    <FieldDescription>사이드바에서 프로젝트를 고르면 그 프로젝트의 설정이 보여요.</FieldDescription>
  );
}

/** A path as the page shows it: the home folder as `~`, and only its end when it is long. */
function shortPath(path: string) {
  const fromHome = path
    .replace(/^\/(?:Users|home)\/[^/]+/u, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/u, "~");
  const parts = fromHome.split(/[/\\]/u);
  return parts.length > 5 ? `…/${parts.slice(-3).join("/")}` : fromHome;
}

/** A file of the project named from the project, a file elsewhere by its shortened path. */
function pathIn(project: Project, path: string) {
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
function SourceFiles({ files, note }: { files: readonly SourceFile[]; note?: string }) {
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

const scopeLabels = { global: "공통", project: "프로젝트" } as const;
/** Skills also come built into the app, which MCP servers and agents do not. */
const skillScopeLabels = { builtin: "기본", ...scopeLabels } as const;

/** One configured MCP server or agent: name, where it is set, how it runs, and what to do. */
function ConfigEntry({
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
function TrustButton({
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

const shadowedBadge = <Badge variant="outline">프로젝트 설정으로 대체됨</Badge>;

function KagiBadge({ status }: { status: KagiStatus }) {
  if (status.enabled) return <Badge>켜짐</Badge>;
  if (status.keyRegistered) return <Badge variant="secondary">꺼짐</Badge>;
  return <Badge variant="outline">키 없음</Badge>;
}

/** Kagi Search and Extract (R19): a key in the keychain, then an explicit switch. */
function isCrossProviderMediaConsentMode(
  value: string | null,
): value is CrossProviderMediaConsentMode {
  return value === "disabled" || value === "ask" || value === "always";
}

function ImageSettings() {
  const [status, setStatus] = useState<ImageSettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .imageSettings()
      .then(setStatus)
      .catch(() => setError("이미지 설정을 불러오지 못했어요."));
  }, []);

  const setImageGenerationEnabled = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.setImageGenerationEnabled(enabled));
    } catch {
      setError("이미지 설정을 바꾸지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const applyCrossProviderMode = async (mode: CrossProviderMediaConsentMode) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.setCrossProviderMediaConsent(mode));
    } catch {
      setError("공급자 간 이미지 실행 동의를 바꾸지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <PageHeader
      title="이미지 생성"
      badge={
        status && (
          <Badge variant={status.imageGenerationEnabled ? "secondary" : "outline"}>
            {status.imageGenerationEnabled ? "사용 중" : "꺼짐"}
          </Badge>
        )
      }
      description="이미지 생성이 필요할 때만 작성창에서 생성 모드를 선택해 사용해요. 일반 대화에는 이미지 도구가 추가되지 않아요."
    />
  );
  if (!status)
    return (
      <FieldGroup>
        {header}
        <PageLoading error={error} />
      </FieldGroup>
    );

  return (
    <FieldGroup>
      {header}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="image-generation-enabled">이미지 생성 사용</FieldLabel>
          <FieldDescription>
            OpenAI API 키가 필요하며 생성할 때마다 비용이 발생할 수 있어요. 설정은 바로 적용되고
            앱을 다시 시작할 필요가 없어요.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="image-generation-enabled"
          checked={status.imageGenerationEnabled}
          disabled={busy}
          onCheckedChange={(checked) => void setImageGenerationEnabled(checked)}
        />
      </Field>
      <Alert>
        <AlertDescription>
          켜도 이미지는 자동으로 생성되지 않아요. 작성창에서 이미지 생성 모드를 선택한 요청만
          처리하고, 유료 실행 전에는 별도로 확인해요.
        </AlertDescription>
      </Alert>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="cross-provider-media">Claude에서 이미지 생성</FieldLabel>
          <FieldDescription>
            Claude 사용 중 이미지 생성을 요청하면 프롬프트를 OpenAI로 보내요. 사용량은 OpenAI 계정에
            귀속되며, 로그인만으로 자동 허용되지 않아요.
          </FieldDescription>
        </FieldContent>
        <Select
          value={
            status.crossProviderMediaConsent.pairs["anthropic->openai:media.image.generate"] ??
            "disabled"
          }
          disabled={busy || !status.imageGenerationEnabled}
          onValueChange={(value) => {
            if (isCrossProviderMediaConsentMode(value)) void applyCrossProviderMode(value);
          }}
        >
          <SelectTrigger id="cross-provider-media" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">사용 안 함</SelectItem>
            <SelectItem value="ask">매번 확인</SelectItem>
            <SelectItem value="always">항상 허용</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  );
}

function KagiSettings() {
  const [status, setStatus] = useState<KagiStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .kagi()
      .then(setStatus)
      .catch((failure: Error) => setError(errorMessage(failure)));
  }, []);

  const apply = async (
    command: { action: "register"; key: string } | { action: "remove" | "enable" | "disable" },
  ) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.kagiAction(command));
      if (command.action === "register") setKey("");
    } catch (failure) {
      setError(errorMessage(failure instanceof Error ? failure : new Error(String(failure))));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <PageHeader
      title="웹 검색"
      badge={status && <KagiBadge status={status} />}
      description="켜면 모델이 필요할 때 Kagi로 웹을 검색하고 페이지를 읽어요. 모든 프로젝트에 적용되고, 호출마다 Kagi 요금이 나가요."
    />
  );
  if (!status)
    return (
      <FieldGroup>
        {header}
        <PageLoading error={error} />
      </FieldGroup>
    );

  return (
    <FieldGroup>
      {header}
      {status.keyRegistered ? (
        <>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="kagi-enabled">검색과 페이지 읽기 사용</FieldLabel>
              <FieldDescription>
                실패해도 다시 시도하지 않아요. 끄면 다음 호출부터 바로 막혀요.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="kagi-enabled"
              checked={status.enabled}
              disabled={busy}
              onCheckedChange={(checked) => void apply({ action: checked ? "enable" : "disable" })}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>API 키</FieldTitle>
              <FieldDescription>
                OS 키체인에 저장돼 있어요. 화면에 다시 보여주지 않아요.
              </FieldDescription>
            </FieldContent>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void apply({ action: "remove" })}
            >
              <Trash2Icon /> 키 삭제
            </Button>
          </Field>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) void apply({ action: "register", key });
          }}
        >
          <Field>
            <FieldLabel htmlFor="kagi-key">API 키</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="kagi-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="kagi.com/api/keys에서 발급한 키"
              />
              <Button type="submit" variant="outline" disabled={busy || !key.trim()}>
                {busy ? <Spinner /> : <KeyRoundIcon />} 저장
              </Button>
            </div>
            <FieldDescription>
              키는 OS 키체인에만 저장되고 모델, 대화, 로그에는 보이지 않아요. 저장해도 저절로
              켜지지는 않아요.
            </FieldDescription>
          </Field>
        </form>
      )}
      <PageError error={error} />
    </FieldGroup>
  );
}

const sourceNames = { "claude-code": "Claude Code", codex: "Codex CLI" } as const;

/** Why registering a recorded working directory as a project did not work. */
const UnplacedReason = Schema.Literal(
  "not_found",
  "not_directory",
  "overlaps_storage",
  "no_session_line",
  "no_project",
);
const unplacedReasons = {
  not_found: "폴더가 없어졌어요",
  not_directory: "폴더가 아니에요",
  overlaps_storage: "이 앱의 저장 폴더 안이에요",
  no_session_line: "어느 대화인지 알 수 없어요",
  no_project: "프로젝트를 찾지 못했어요",
} satisfies Record<typeof UnplacedReason.Type, string>;
const isUnplacedReason = Schema.is(UnplacedReason);

/** A reason this build does not know yet is shown as it came, rather than hidden. */
const unplacedReason = (reason: string) =>
  isUnplacedReason(reason) ? unplacedReasons[reason] : reason;

/** How often the page asks again while a pass reads, and while its nodes wait to be indexed. */
/** The pass this server is running, or how its latest one went. */
function ImportActivityLine({ activity }: { activity: ImportActivity }) {
  switch (activity.status) {
    case "running":
      return (
        <FieldDescription className="flex items-center">
          <Spinner className="mr-1.5" />
          <span>
            기록을 읽는 중이에요. <AnimatedNumber value={activity.checked} />/
            <AnimatedNumber value={activity.total} />
            개를 확인하고 노드 <AnimatedNumber value={activity.written} />
            개를 더했어요.
            {activity.failed > 0 && (
              <>
                {" "}
                <AnimatedNumber value={activity.failed} />
                개는 읽지 못했어요.
              </>
            )}
          </span>
        </FieldDescription>
      );
    case "finished":
      return (
        <FieldDescription>
          {timeOfDay(activity.finishedAt)}에 기록 {activity.checked}개를 확인하고 노드{" "}
          {activity.written}개를 더했어요.
          {activity.failed > 0 && ` ${activity.failed}개는 읽지 못했어요.`}
        </FieldDescription>
      );
    case "crashed":
      return (
        <FieldError>
          {timeOfDay(activity.finishedAt)}에 가져오기가 중간에 멈췄어요: {activity.reason}
        </FieldError>
      );
  }
}

/** Migrating other coding agents' local conversations into this app's memory. */
function ImportSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: appQueryKeys.global.imports, queryFn: api.imports });
  const overview = query.data ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.error instanceof Error) setError(errorMessage(query.error));
  }, [query.error]);
  const reading = overview?.activity?.status === "running";

  const apply = async (
    command: { action: "run" | "enable" | "disable" } | { action: "interpret"; interpret: boolean },
  ) => {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(appQueryKeys.global.imports, await api.importAction(command));
    } catch (failure) {
      setError(errorMessage(failure instanceof Error ? failure : new Error(String(failure))));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <PageHeader
      title="대화 가져오기"
      description="Claude Code와 Codex CLI가 이 컴퓨터에 남긴 대화를 기억으로 옮겨요. 도구 호출과 결과까지 옮겨서 옛 대화도 근거를 따라갈 수 있고, 원본 파일은 읽기만 해요."
      action={
        overview && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || reading}
            onClick={() => void apply({ action: "run" })}
          >
            {busy || reading ? <Spinner /> : <RefreshCwIcon />}
            {reading ? "읽는 중" : "지금 가져오기"}
          </Button>
        )
      }
    />
  );
  if (!overview)
    return (
      <FieldGroup>
        {header}
        <PageLoading error={error} />
      </FieldGroup>
    );

  return (
    <FieldGroup>
      {header}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="imports-enabled">계속 가져오기</FieldLabel>
          <FieldDescription>
            5분마다 새로 쌓인 대화를 이어서 읽어요. 켤 때 지금 있는 기록을 한 번 읽어요.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="imports-enabled"
          checked={overview.enabled}
          disabled={busy}
          onCheckedChange={(checked) => void apply({ action: checked ? "enable" : "disable" })}
        />
      </Field>

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="imports-interpret">가져온 발언도 해석</FieldLabel>
          <FieldDescription>
            주제를 붙이고 정정, 취소 관계를 정리해요. 모델을 쓰기 때문에 답변이 끝난 뒤 조금씩
            처리돼요.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="imports-interpret"
          checked={overview.interpret}
          disabled={busy}
          onCheckedChange={(checked) => void apply({ action: "interpret", interpret: checked })}
        />
      </Field>

      <ItemGroup>
        {overview.sources.map((source) => (
          <Item key={source.name} variant="outline" size="sm">
            <ItemMedia variant="icon">
              <BotIcon />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle>{sourceNames[source.name]}</ItemTitle>
              <ItemDescription>
                기록 <AnimatedNumber value={source.transcripts} />개 중{" "}
                <AnimatedNumber value={source.migrated} />
                개를 읽어 노드 <AnimatedNumber value={source.nodes} />
                개를 넣었어요.
                {source.failed > 0 && ` ${source.failed}개는 읽지 못했어요.`}
              </ItemDescription>
              <ItemDescription className="break-all" title={source.root}>
                <code>{shortPath(source.root)}</code>
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>

      {overview.activity && <ImportActivityLine activity={overview.activity} />}

      {overview.unindexed > 0 && (
        <FieldDescription>
          아직 <AnimatedNumber value={overview.unindexed} />
          개를 인덱싱하고 있어요. 최근 대화부터 채우고, 그동안에도 글자 검색과 형태소 검색으로는
          찾을 수 있어요.
        </FieldDescription>
      )}

      <FieldDescription>
        대화가 있던 폴더는 프로젝트로 등록돼요. 에이전트가 그 폴더의 파일을 읽고 고칠 수 있게 되니,
        필요 없는 프로젝트는 사이드바에서 목록에서 빼세요.
      </FieldDescription>

      {overview.unplaced.length > 0 && (
        <Alert>
          <AlertDescription>
            <div className="mb-1">아래 폴더는 프로젝트로 만들 수 없어 가져오지 않았어요.</div>
            <ul className="font-mono text-xs">
              {overview.unplaced.map((folder) => (
                <li key={`${folder.cwd}:${folder.reason}`}>
                  {folder.cwd}: 대화 {folder.transcripts}개, {unplacedReason(folder.reason)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {overview.failures.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <div className="mb-1">아래 기록은 읽지 못했어요. 다음에 읽을 때 다시 시도해요.</div>
            <ul className="font-mono text-xs">
              {overview.failures.map((failure) => (
                <li key={`${failure.source}:${failure.path}`}>
                  {failure.path}: {failure.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <PageError error={error} />
    </FieldGroup>
  );
}

const embeddingChoices = [
  { value: "auto", label: "자동" },
  { value: "cpu", label: "CPU (메모리 적게)" },
  { value: "gpu", label: "GPU (CPU 적게)" },
] as const satisfies ReadonlyArray<{ value: EmbeddingChoice; label: string }>;

const modeNames = { cpu: "CPU", gpu: "GPU" } as const;

/** How often the page asks again while WebGPU is checked or nodes wait to be embedded. */
const gibibytes = (bytes: number) => Math.round(bytes / 1024 ** 3);

/** What the model runs on in this process, as a badge. */
function RunningBadge({ running }: { running: EmbeddingOverview["running"] }) {
  switch (running.kind) {
    case "other":
      return null;
    case "local":
      if (running.device === null)
        return (
          <Badge variant="secondary">{modeNames[running.mode]} 모드, 아직 불러오지 않음</Badge>
        );
      switch (running.mode) {
        case "cpu":
          return <Badge variant="secondary">CPU에서 실행 중</Badge>;
        case "gpu":
          return running.device === "webgpu" ? (
            <Badge variant="secondary">GPU(WebGPU)에서 실행 중</Badge>
          ) : (
            <Badge variant="outline">GPU 모드, CPU에서 실행 중</Badge>
          );
      }
  }
}

/** What the running model means for the user, in words; nothing when the badge says it all. */
function runningNote(running: EmbeddingOverview["running"]) {
  switch (running.kind) {
    case "other":
      return null;
    case "local":
      if (running.device === null) return "모델은 처음 임베딩할 때 불러와요.";
      switch (running.mode) {
        case "cpu":
          return null;
        case "gpu":
          return running.device === "webgpu"
            ? null
            : "WebGPU를 쓸 수 없어 CPU에서 원본 모델을 돌리고 있어요. 벡터는 같지만 더 느려요.";
      }
  }
}

function gpuText(gpu: GpuState) {
  switch (gpu.status) {
    case "unchecked":
      return "아직 확인하지 않았어요.";
    case "checking":
      return "확인하는 중이에요. 처음이면 원본 모델(약 390MB)을 내려받아요.";
    case "available":
      return `쓸 수 있어요(${dayAndTime(gpu.checkedAt)} 확인).`;
    case "unavailable":
      return `쓸 수 없어요(${dayAndTime(gpu.checkedAt)} 확인): ${gpu.reason}`;
  }
}

/** How the embedding model runs: on the CPU with little memory, or on the GPU with little CPU. */
function EmbeddingSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: appQueryKeys.global.embedding, queryFn: api.embedding });
  const overview = query.data ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.error instanceof Error) setError(errorMessage(query.error));
  }, [query.error]);
  const checking = overview?.gpu.status === "checking";
  const indexing = (overview?.unindexed ?? 0) > 0;

  const apply = async (
    command: { action: "choose"; choice: EmbeddingChoice } | { action: "check" },
  ) => {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(appQueryKeys.global.embedding, await api.embeddingAction(command));
    } catch (failure) {
      setError(errorMessage(failure instanceof Error ? failure : new Error(String(failure))));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <PageHeader
      title="임베딩"
      badge={overview && <RunningBadge running={overview.running} />}
      description="기억을 뜻으로 찾을 때 쓰는 벡터를 어디서 만들지 정해요. 사용자와 모델의 발언만 임베딩하고, 도구 기록은 글자 검색으로 찾아요."
    />
  );
  if (!overview)
    return (
      <FieldGroup>
        {header}
        <PageLoading error={error} />
      </FieldGroup>
    );

  const note = runningNote(overview.running);
  const restartNeeded =
    overview.running.kind === "local" && overview.running.mode !== overview.next;

  return (
    <FieldGroup>
      {header}

      <Field>
        <FieldLabel htmlFor="embedding-device">실행 방식</FieldLabel>
        <Select
          value={overview.choice}
          items={embeddingChoices}
          disabled={busy}
          onValueChange={(value) => {
            const choice = embeddingChoices.find((option) => option.value === value);
            if (choice) void apply({ action: "choose", choice: choice.value });
          }}
        >
          <SelectTrigger id="embedding-device" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {embeddingChoices.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          CPU는 메모리를 적게 쓰는 대신 벡터를 만드는 동안 코어를 여럿 써요. GPU는 CPU를 훨씬 덜
          쓰지만 메모리를 1~1.6GB 더 써요. 자동은 메모리가 {gibibytes(overview.gpuMemoryThreshold)}
          GB 이상이고 WebGPU가 되면 GPU를 써요. 이 기기의 메모리는 {gibibytes(overview.memoryBytes)}
          GB예요.
        </FieldDescription>
      </Field>

      {note && <FieldDescription>{note}</FieldDescription>}
      {restartNeeded && (
        <Alert>
          <AlertDescription>
            앱을 다시 시작하면 {modeNames[overview.next]} 모드로 돌아가요. 그 모드로 만든 벡터가
            없으면 처음부터 다시 만들고, 그동안에도 글자 검색과 형태소 검색은 돼요.
          </AlertDescription>
        </Alert>
      )}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>WebGPU</FieldTitle>
          <FieldDescription>{gpuText(overview.gpu)}</FieldDescription>
        </FieldContent>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || checking}
          onClick={() => void apply({ action: "check" })}
        >
          {busy || checking ? <Spinner /> : <RefreshCwIcon />} 다시 확인
        </Button>
      </Field>

      {indexing && (
        <FieldDescription>
          아직 <AnimatedNumber value={overview.unindexed} />
          개를 임베딩하지 않았어요. 최근 대화부터 채워요.
        </FieldDescription>
      )}

      <PageError error={error} />
    </FieldGroup>
  );
}

function McpStateBadge({ server }: { server: McpServerView }) {
  if (server.shadowed) return shadowedBadge;
  switch (server.state.status) {
    case "untrusted":
      return <Badge variant="outline">신뢰 필요</Badge>;
    case "changed":
      return <Badge variant="destructive">설정 바뀜, 다시 신뢰 필요</Badge>;
    case "trusted":
      return <Badge variant="secondary">다음 대화에서 시작</Badge>;
    case "connected":
      return <Badge>도구 {server.state.tools.length}개</Badge>;
    case "failed":
      return <Badge variant="destructive">시작 실패</Badge>;
  }
}

/** MCP servers from the user-wide and project config files (R18). */
function McpSettings({ project }: { project: Project | null }) {
  const [overview, setOverview] = useState<McpOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    void api
      .mcpServers(project.id)
      .then(setOverview)
      .catch(() => setError("MCP 설정을 읽지 못했어요."));
  }, [project]);

  const header = (
    <PageHeader
      title="MCP 서버"
      project={project}
      description="신뢰한 서버만 시작해요. 설정 파일이 바뀌면 다시 신뢰해야 하고, 신뢰해도 도구를 부를 때마다 승인이나 자동 판단을 거쳐요."
    />
  );
  if (!project)
    return (
      <FieldGroup>
        {header}
        <NoProject />
      </FieldGroup>
    );
  if (!overview)
    return (
      <FieldGroup>
        {header}
        <PageLoading error={error} />
      </FieldGroup>
    );

  const trust = async (server: McpServerView, trusted: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setOverview(await api.setMcpTrusted(project.id, server.scope, server.name, trusted));
    } catch {
      setError("바꾸지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FieldGroup>
      {header}
      <SourceFiles
        files={overview.files.map((file) => ({
          label: scopeLabels[file.scope],
          path: file.path,
          shown: pathIn(project, file.path),
          error: file.error,
        }))}
        note="이름이 같으면 프로젝트 설정을 써요."
      />
      {overview.servers.length === 0 ? (
        <FieldDescription>설정된 MCP 서버가 없어요.</FieldDescription>
      ) : (
        <ItemGroup>
          {overview.servers.map((server) => {
            const active = server.state.status !== "untrusted" && server.state.status !== "changed";
            return (
              <ConfigEntry
                key={`${server.scope}/${server.name}`}
                icon={<PlugIcon />}
                name={server.name}
                scope={server.scope}
                state={<McpStateBadge server={server} />}
                target={server.target}
                secretKind={server.transport === "stdio" ? "환경 변수" : "헤더"}
                secretNames={[...server.envNames, ...server.headerNames]}
                problem={server.state.status === "failed" ? server.state.error : null}
                actions={
                  !server.shadowed && (
                    <TrustButton
                      active={active}
                      changed={server.state.status === "changed"}
                      busy={busy}
                      onClick={() => void trust(server, !active)}
                    />
                  )
                }
              >
                {server.state.status === "connected" && server.state.tools.length > 0 && (
                  <ItemDescription>
                    <code>{server.state.tools.join(", ")}</code>
                  </ItemDescription>
                )}
              </ConfigEntry>
            );
          })}
        </ItemGroup>
      )}
      <PageError error={error} />
    </FieldGroup>
  );
}

function AgentStateBadge({ agent }: { agent: ExternalAgentView }) {
  if (agent.shadowed) return shadowedBadge;
  switch (agent.state.status) {
    case "untrusted":
      return <Badge variant="outline">신뢰 필요</Badge>;
    case "changed":
      return <Badge variant="destructive">설정 바뀜, 다시 신뢰 필요</Badge>;
    case "trusted":
      switch (agent.state.link.status) {
        case "idle":
          return <Badge variant="secondary">쓸 때 시작</Badge>;
        case "connecting":
          return <Badge variant="secondary">연결 중</Badge>;
        case "connected":
          return <Badge>연결됨</Badge>;
        case "retrying":
          return <Badge variant="outline">연결 실패 {agent.state.link.failures}회</Badge>;
        case "stopped":
          return <Badge variant="destructive">재연결 중단</Badge>;
      }
  }
}

/** Why a trusted agent is not connected, when it tried and failed. */
function agentProblem(agent: ExternalAgentView) {
  switch (agent.state.status) {
    case "untrusted":
    case "changed":
      return null;
    case "trusted":
      switch (agent.state.link.status) {
        case "idle":
        case "connecting":
        case "connected":
          return null;
        case "retrying":
          return agent.state.link.error;
        case "stopped":
          return `${agent.state.link.error} 두 번 연달아 실패해서 멈췄어요. 다시 연결을 눌러 주세요.`;
      }
  }
}

/** External ACP agents (Codex and others) the conversation may delegate to (R17). */
function AgentSettings({ project }: { project: Project | null }) {
  const [overview, setOverview] = useState<ExternalAgentsOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    void api
      .externalAgents(project.id)
      .then(setOverview)
      .catch(() => setError("에이전트 설정을 읽지 못했어요."));
  }, [project]);

  const header = (
    <PageHeader
      title="외부 에이전트"
      project={project}
      description="신뢰한 ACP 에이전트에게 모델이 작업을 맡길 수 있어요. 맡길 때마다 승인하고, 에이전트는 이 앱의 ChatGPT 로그인이 아니라 자기 로그인으로 일해요."
    />
  );
  if (!project)
    return (
      <FieldGroup>
        {header}
        <NoProject />
      </FieldGroup>
    );
  if (!overview)
    return (
      <FieldGroup>
        {header}
        <PageLoading error={error} />
      </FieldGroup>
    );

  const apply = async (change: () => Promise<ExternalAgentsOverview>) => {
    setBusy(true);
    setError(null);
    try {
      setOverview(await change());
    } catch {
      setError("바꾸지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FieldGroup>
      {header}
      <SourceFiles
        files={overview.files.map((file) => ({
          label: scopeLabels[file.scope],
          path: file.path,
          shown: pathIn(project, file.path),
          error: file.error,
        }))}
        note="이름이 같으면 프로젝트 설정을 써요."
      />
      {overview.agents.length === 0 ? (
        <FieldDescription>설정된 에이전트가 없어요.</FieldDescription>
      ) : (
        <ItemGroup>
          {overview.agents.map((agent) => {
            const trusted = agent.state.status === "trusted";
            const stopped =
              agent.state.status === "trusted" && agent.state.link.status === "stopped";
            return (
              <ConfigEntry
                key={`${agent.scope}/${agent.name}`}
                icon={<BotIcon />}
                name={agent.name}
                scope={agent.scope}
                state={<AgentStateBadge agent={agent} />}
                target={agent.target}
                secretKind="환경 변수"
                secretNames={agent.envNames}
                problem={agentProblem(agent)}
                actions={
                  !agent.shadowed && (
                    <>
                      {stopped && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void apply(() => api.reconnectExternalAgent(project.id, agent.name))
                          }
                        >
                          <RefreshCwIcon /> 다시 연결
                        </Button>
                      )}
                      <TrustButton
                        active={trusted}
                        changed={agent.state.status === "changed"}
                        busy={busy}
                        onClick={() =>
                          void apply(() =>
                            api.trustExternalAgent(project.id, agent.scope, agent.name, !trusted),
                          )
                        }
                      />
                    </>
                  )
                }
              />
            );
          })}
        </ItemGroup>
      )}
      <PageError error={error} />
    </FieldGroup>
  );
}

const skillProblems = {
  no_description: "description이 없어 쓰지 않아요.",
  too_large: "SKILL.md가 너무 커서 쓰지 않아요.",
  unreadable: "읽지 못했어요.",
} as const;

/** Skills the model can read in this project (R18). They are instructions, not permissions. */
function SkillSettings({ project }: { project: Project | null }) {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    void api
      .skills(project.id)
      .then(setCatalog)
      .catch(() => setError("skill 목록을 읽지 못했어요."));
  }, [project]);

  const header = (
    <PageHeader
      title="Skills"
      project={project}
      badge={catalog && <Badge variant="secondary">{catalog.skills.length}개</Badge>}
      description="모델이 이름과 설명을 보고 작업에 맞는 skill을 읽어 따라요. skill은 지침일 뿐이라 승인을 대신하지 않아요."
    />
  );
  if (!project)
    return (
      <FieldGroup>
        {header}
        <NoProject />
      </FieldGroup>
    );
  if (!catalog)
    return (
      <FieldGroup>
        {header}
        <PageLoading error={error} />
      </FieldGroup>
    );

  return (
    <FieldGroup>
      {header}
      <SourceFiles
        files={catalog.directories.map((directory) => ({
          label: skillScopeLabels[directory.scope],
          path: directory.path,
          shown: pathIn(project, directory.path),
        }))}
        note="이름이 같으면 프로젝트, 공통, 기본 순으로 앞의 것을 써요. 기본 skill도 같은 이름으로 덮어쓸 수 있어요."
      />
      {catalog.problems.map((problem) => (
        <FieldError key={problem.directory}>
          <code className="break-all">{pathIn(project, problem.directory)}</code>:{" "}
          {skillProblems[problem.problem]}
        </FieldError>
      ))}
      {catalog.skills.length === 0 ? (
        <FieldDescription>쓸 수 있는 skill이 없어요.</FieldDescription>
      ) : (
        <ItemGroup>
          {catalog.skills.map((skill) => (
            <Item key={`${skill.scope}/${skill.name}`} variant="outline" size="sm">
              <ItemMedia variant="icon">
                <BookOpenIcon />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>
                  {skill.name}
                  <Badge variant="secondary">{skillScopeLabels[skill.scope]}</Badge>
                </ItemTitle>
                <ItemDescription>{skill.description}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </FieldGroup>
  );
}

/** The pages of the dialog, in the groups the list on the left shows. */
const settingsGroups = [
  {
    label: "연결",
    pages: [
      { value: "web", label: "웹 검색", icon: GlobeIcon },
      { value: "image", label: "이미지 생성", icon: ImageIcon },
      { value: "mcp", label: "MCP 서버", icon: PlugIcon },
      { value: "agents", label: "외부 에이전트", icon: BotIcon },
    ],
  },
  {
    label: "기억",
    pages: [
      { value: "imports", label: "대화 가져오기", icon: HistoryIcon },
      { value: "embedding", label: "임베딩", icon: CpuIcon },
    ],
  },
  { label: "지침", pages: [{ value: "skills", label: "Skills", icon: BookOpenIcon }] },
] as const;

type SettingsPage = (typeof settingsGroups)[number]["pages"][number]["value"];

function SettingsPageBody({ page, project }: { page: SettingsPage; project: Project | null }) {
  switch (page) {
    case "web":
      return <KagiSettings />;
    case "image":
      return <ImageSettings />;
    case "mcp":
      return <McpSettings project={project} />;
    case "agents":
      return <AgentSettings project={project} />;
    case "imports":
      return <ImportSettings />;
    case "embedding":
      return <EmbeddingSettings />;
    case "skills":
      return <SkillSettings project={project} />;
  }
}

/**
 * Settings that apply beyond one conversation. The dialog keeps one size while pages change; a
 * page scrolls inside it.
 */
export function SettingsDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project | null;
  /** Controlled so `/settings` can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="설정" />}>
        <SettingsIcon />
      </DialogTrigger>
      <DialogContent className="flex h-[min(40rem,calc(100dvh-2rem))] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>대화 밖에서 쓰는 도구와 연결을 관리해요.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="web" orientation="vertical" className="min-h-0 flex-1">
          <div className="mr-2 w-40 shrink-0 border-r pr-3">
            <TabsList variant="nav" className="w-full items-stretch justify-start">
              {settingsGroups.map((group) => (
                <div key={group.label} className="flex flex-col gap-0.5 not-first:pt-3">
                  <div className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                    {group.label}
                  </div>
                  {group.pages.map((page) => (
                    <TabsTrigger key={page.value} value={page.value}>
                      <page.icon />
                      {page.label}
                    </TabsTrigger>
                  ))}
                </div>
              ))}
            </TabsList>
          </div>
          {settingsGroups.flatMap((group) =>
            group.pages.map((page) => (
              <TabsContent
                key={page.value}
                value={page.value}
                className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto data-ending-style:hidden"
              >
                <div className="pr-2">
                  <SettingsPageBody page={page.value} project={project} />
                </div>
              </TabsContent>
            )),
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
