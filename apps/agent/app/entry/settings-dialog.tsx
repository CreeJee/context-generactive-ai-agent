import {
  BookOpenIcon,
  BotIcon,
  KeyRoundIcon,
  PlugIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { Schema } from "effect";
import { useEffect, useState } from "react";
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
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  ApiError,
  api,
  type ExternalAgentView,
  type ExternalAgentsOverview,
  type ImportActivity,
  type ImportOverview,
  type KagiStatus,
  type McpOverview,
  type McpServerView,
  type Project,
  type SkillCatalog,
} from "./api";

const kagiErrors = new Map([
  ["keychain_failed", "OS 키체인에 접근하지 못했어요. 키를 다른 곳에 대신 저장하지 않아요."],
  ["kagi_key_required", "먼저 API 키를 등록하세요."],
]);

const errorMessage = (error: Error) =>
  (error instanceof ApiError && kagiErrors.get(error.code)) || "설정을 바꾸지 못했어요.";

function KagiBadge({ status }: { status: KagiStatus }) {
  if (status.enabled) return <Badge>켜짐</Badge>;
  if (status.keyRegistered) return <Badge variant="secondary">꺼짐</Badge>;
  return <Badge variant="outline">키 없음</Badge>;
}

/** Kagi Search and Extract (R19): a key in the keychain, then an explicit switch. */
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

  if (!status) return error ? <FieldDescription>{error}</FieldDescription> : <Spinner />;

  return (
    <FieldGroup>
      <div className="flex items-center gap-2">
        <FieldTitle>Kagi Search · Extract</FieldTitle>
        <KagiBadge status={status} />
      </div>
      <FieldDescription>
        켜면 모델이 필요할 때 웹을 검색하고 페이지를 읽어요. 호출마다 Kagi 계정에 요금이 청구되고,
        실패해도 자동으로 다시 시도하지 않아요. 모든 프로젝트에 적용돼요.
      </FieldDescription>

      {status.keyRegistered ? (
        <>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="kagi-enabled">검색·페이지 읽기 사용</FieldLabel>
              <FieldDescription>끄면 다음 호출부터 바로 막혀요.</FieldDescription>
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
                placeholder="kagi.com/api/keys 에서 발급한 키"
              />
              <Button type="submit" variant="outline" disabled={busy || !key.trim()}>
                {busy ? <Spinner /> : <KeyRoundIcon />} 저장
              </Button>
            </div>
            <FieldDescription>
              키는 OS 키체인에만 저장되고 모델·대화·로그에는 보이지 않아요. 저장만으로 켜지지
              않아요.
            </FieldDescription>
          </Field>
        </form>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
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

/** How often the tab asks again while a pass reads, and while its nodes wait to be indexed. */
const refreshWhileReadingMs = 1_000;
const refreshWhileIndexingMs = 3_000;

const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

/** The pass this server is running, or how its latest one went. */
function ImportActivityLine({ activity }: { activity: ImportActivity }) {
  switch (activity.status) {
    case "running":
      return (
        <FieldDescription className="flex items-center">
          <Spinner className="mr-1.5" />
          <span>
            기록을 읽는 중이에요 · <AnimatedNumber value={activity.checked} />/
            <AnimatedNumber value={activity.total} />개 확인 · 노드{" "}
            <AnimatedNumber value={activity.written} />개 추가
            {activity.failed > 0 && (
              <>
                {" "}
                · <AnimatedNumber value={activity.failed} />개 실패
              </>
            )}
          </span>
        </FieldDescription>
      );
    case "finished":
      return (
        <FieldDescription>
          {clockTime(activity.finishedAt)}에 기록 {activity.checked}개를 확인하고 노드{" "}
          {activity.written}개를 더했어요.
          {activity.failed > 0 && ` ${activity.failed}개는 읽지 못했어요.`}
        </FieldDescription>
      );
    case "crashed":
      return (
        <FieldError>
          {clockTime(activity.finishedAt)}에 가져오기가 중간에 멈췄어요: {activity.reason}
        </FieldError>
      );
  }
}

/** Migrating other coding agents' local conversations into this app's memory. */
function ImportSettings() {
  const [overview, setOverview] = useState<ImportOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .imports()
      .then(setOverview)
      .catch((failure: Error) => setError(errorMessage(failure)));
  }, []);

  // A pass and the indexing after it run in the background; the numbers follow them while open.
  const reading = overview?.activity?.status === "running";
  const indexing = (overview?.unindexed ?? 0) > 0;
  useEffect(() => {
    if (!reading && !indexing) return;
    const timer = setInterval(
      () =>
        void api
          .imports()
          .then(setOverview)
          .catch(() => undefined),
      reading ? refreshWhileReadingMs : refreshWhileIndexingMs,
    );
    return () => clearInterval(timer);
  }, [reading, indexing]);

  const apply = async (
    command: { action: "run" | "enable" | "disable" } | { action: "interpret"; interpret: boolean },
  ) => {
    setBusy(true);
    setError(null);
    try {
      setOverview(await api.importAction(command));
    } catch (failure) {
      setError(errorMessage(failure instanceof Error ? failure : new Error(String(failure))));
    } finally {
      setBusy(false);
    }
  };

  if (!overview) return error ? <FieldDescription>{error}</FieldDescription> : <Spinner />;

  return (
    <FieldGroup>
      <FieldTitle>다른 에이전트의 대화 가져오기</FieldTitle>
      <FieldDescription>
        Claude Code와 Codex CLI가 이 컴퓨터에 남긴 대화를 읽어 기억으로 옮겨요. 발언뿐 아니라 도구
        호출과 결과까지 그대로 옮겨서, 옛 대화도 근거를 따라갈 수 있어요. 원본 파일은 건드리지 않고
        읽기만 해요. 대화가 있던 폴더는 프로젝트로 자동 등록되고, 그 폴더의 파일은 에이전트가 읽고
        고칠 수 있게 돼요. 필요 없는 프로젝트는 사이드바에서 목록에서 뺄 수 있어요.
      </FieldDescription>

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

      <ItemGroup>
        {overview.sources.map((source) => (
          <Item key={source.name} variant="outline">
            <ItemMedia>
              <BotIcon className="size-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{sourceNames[source.name]}</ItemTitle>
              <ItemDescription>
                기록 <AnimatedNumber value={source.transcripts} />개 중{" "}
                <AnimatedNumber value={source.migrated} />
                개를 읽어 <AnimatedNumber value={source.nodes} />
                개를 기억에 넣었어요.
                {source.failed > 0 && ` ${source.failed}개는 읽지 못했어요.`}
              </ItemDescription>
              <ItemDescription>
                <code>{source.root}</code>
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>

      {overview.activity && <ImportActivityLine activity={overview.activity} />}

      {overview.unindexed > 0 && (
        <FieldDescription>
          아직 <AnimatedNumber value={overview.unindexed} />
          개를 인덱싱하고 있어요. 최근 대화부터 들어가고, 옛 기록은 뒤에서 채워요. 그동안에도
          글자·형태소 검색으로는 찾을 수 있어요.
        </FieldDescription>
      )}

      {overview.unplaced.length > 0 && (
        <Alert>
          <AlertDescription>
            <div className="mb-1">아래 폴더는 프로젝트로 만들 수 없어 가져오지 않았어요.</div>
            <ul className="font-mono text-xs">
              {overview.unplaced.map((folder) => (
                <li key={`${folder.cwd}:${folder.reason}`}>
                  {folder.cwd} · 대화 {folder.transcripts}개 · {unplacedReason(folder.reason)}
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
                  {failure.path} · {failure.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="imports-interpret">가져온 발언도 해석</FieldLabel>
          <FieldDescription>
            주제와 정정·취소 관계를 붙여요. 모델을 쓰기 때문에 답변이 끝난 뒤 조금씩 처리돼요.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="imports-interpret"
          checked={overview.interpret}
          disabled={busy}
          onCheckedChange={(checked) => void apply({ action: "interpret", interpret: checked })}
        />
      </Field>

      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>지금 가져오기</FieldTitle>
          <FieldDescription>
            설정을 바꾸지 않고 한 번만 읽어요. 뒤에서 읽으니 창을 닫아도 계속돼요.
          </FieldDescription>
        </FieldContent>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || reading}
          onClick={() => void apply({ action: "run" })}
        >
          {busy || reading ? <Spinner /> : <RefreshCwIcon />} {reading ? "읽는 중" : "읽기"}
        </Button>
      </Field>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  );
}

function McpStateBadge({ server }: { server: McpServerView }) {
  if (server.shadowed) return <Badge variant="outline">프로젝트 설정이 대신함</Badge>;
  switch (server.state.status) {
    case "untrusted":
      return <Badge variant="outline">신뢰 필요</Badge>;
    case "changed":
      return <Badge variant="destructive">설정 바뀜 · 다시 신뢰 필요</Badge>;
    case "trusted":
      return <Badge variant="secondary">다음 대화에서 시작</Badge>;
    case "connected":
      return <Badge>도구 {server.state.tools.length}개</Badge>;
    case "failed":
      return <Badge variant="destructive">시작 실패</Badge>;
  }
}

const scopeLabels = { global: "공통", project: "프로젝트" } as const;
/** Skills also come built into the app, which MCP servers and agents do not. */
const skillScopeLabels = { builtin: "기본", ...scopeLabels } as const;

function McpServerItem({
  server,
  busy,
  onTrust,
}: {
  server: McpServerView;
  busy: boolean;
  onTrust: (trusted: boolean) => void;
}) {
  const trusted = server.state.status !== "untrusted";
  const names = [...server.envNames, ...server.headerNames];
  return (
    <Item variant="outline" size="sm">
      <ItemMedia variant="icon">
        <PlugIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {server.name}
          <Badge variant="secondary">{scopeLabels[server.scope]}</Badge>
          <McpStateBadge server={server} />
        </ItemTitle>
        <ItemDescription className="break-all">
          <code>{server.target}</code>
        </ItemDescription>
        {names.length > 0 && (
          <ItemDescription>
            {server.transport === "stdio" ? "환경 변수" : "헤더"}: {names.join(", ")} (값은 보여주지
            않아요)
          </ItemDescription>
        )}
        {server.state.status === "failed" && (
          <ItemDescription variant="destructive">{server.state.error}</ItemDescription>
        )}
        {server.state.status === "connected" && server.state.tools.length > 0 && (
          <ItemDescription>
            <code>{server.state.tools.join(", ")}</code>
          </ItemDescription>
        )}
      </ItemContent>
      {!server.shadowed && (
        <ItemActions>
          <Button
            size="sm"
            variant={trusted && server.state.status !== "changed" ? "ghost" : "outline"}
            disabled={busy}
            onClick={() => onTrust(!(trusted && server.state.status !== "changed"))}
          >
            {trusted && server.state.status !== "changed" ? "사용 중지" : "신뢰하고 시작"}
          </Button>
        </ItemActions>
      )}
    </Item>
  );
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

  if (!project) return <FieldDescription>프로젝트를 먼저 선택하세요.</FieldDescription>;
  if (!overview) return error ? <FieldDescription>{error}</FieldDescription> : <Spinner />;

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
      <FieldDescription>
        설정 파일에 적힌 서버는 신뢰하기 전에는 시작하지 않아요. 신뢰는 적힌 명령·주소 그대로에만
        적용되고, 파일이 바뀌면 다시 신뢰해야 해요. 신뢰해도 도구 호출은 매번 승인(또는 자동 판단)을
        거쳐요.
      </FieldDescription>
      <div className="flex flex-col gap-1">
        {overview.files.map((file) => (
          <div key={file.scope} className="text-xs text-muted-foreground">
            {scopeLabels[file.scope]}: <code className="break-all">{file.path}</code>
            {file.error && <div className="text-destructive whitespace-pre-wrap">{file.error}</div>}
          </div>
        ))}
      </div>
      {overview.servers.length === 0 ? (
        <FieldDescription>설정된 MCP 서버가 없어요.</FieldDescription>
      ) : (
        <ItemGroup>
          {overview.servers.map((server) => (
            <McpServerItem
              key={`${server.scope}/${server.name}`}
              server={server}
              busy={busy}
              onTrust={(trusted) => void trust(server, trusted)}
            />
          ))}
        </ItemGroup>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  );
}

function AgentStateBadge({ agent }: { agent: ExternalAgentView }) {
  if (agent.shadowed) return <Badge variant="outline">프로젝트 설정이 대신함</Badge>;
  switch (agent.state.status) {
    case "untrusted":
      return <Badge variant="outline">신뢰 필요</Badge>;
    case "changed":
      return <Badge variant="destructive">설정 바뀜 · 다시 신뢰 필요</Badge>;
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

  if (!project) return <FieldDescription>프로젝트를 먼저 선택하세요.</FieldDescription>;
  if (!overview) return error ? <FieldDescription>{error}</FieldDescription> : <Spinner />;

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
      <FieldDescription>
        설정 파일에 적힌 ACP 에이전트를 신뢰하면, 모델이 작업 일부를 맡길 수 있어요. 에이전트는 자기
        공식 로그인으로 동작하고 이 앱의 ChatGPT 토큰·키를 받지 않아요. 맡길 때마다 승인을 받고,
        에이전트가 요청하는 권한도 따로 물어요. 연결이 끊기면 두 번까지 다시 연결하고, 그래도
        실패하면 여기서 다시 연결해야 해요.
      </FieldDescription>
      <div className="flex flex-col gap-1">
        {overview.files.map((file) => (
          <div key={file.scope} className="text-xs text-muted-foreground">
            {scopeLabels[file.scope]}: <code className="break-all">{file.path}</code>
            {file.error && <div className="whitespace-pre-wrap text-destructive">{file.error}</div>}
          </div>
        ))}
      </div>
      {overview.agents.length === 0 ? (
        <FieldDescription>설정된 에이전트가 없어요.</FieldDescription>
      ) : (
        <ItemGroup>
          {overview.agents.map((agent) => {
            const trusted = agent.state.status === "trusted";
            const stopped =
              trusted && agent.state.status === "trusted" && agent.state.link.status === "stopped";
            return (
              <Item key={`${agent.scope}/${agent.name}`} variant="outline" size="sm">
                <ItemMedia variant="icon">
                  <BotIcon />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex-wrap">
                    {agent.name}
                    <Badge variant="secondary">{scopeLabels[agent.scope]}</Badge>
                    <AgentStateBadge agent={agent} />
                  </ItemTitle>
                  <ItemDescription className="break-all">
                    <code>{agent.target}</code>
                  </ItemDescription>
                  {agent.envNames.length > 0 && (
                    <ItemDescription>
                      환경 변수: {agent.envNames.join(", ")} (값은 보여주지 않아요)
                    </ItemDescription>
                  )}
                  {agent.state.status === "trusted" &&
                    (agent.state.link.status === "retrying" ||
                      agent.state.link.status === "stopped") && (
                      <ItemDescription variant="destructive">
                        {agent.state.link.error}
                      </ItemDescription>
                    )}
                </ItemContent>
                {!agent.shadowed && (
                  <ItemActions>
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
                    <Button
                      size="sm"
                      variant={trusted ? "ghost" : "outline"}
                      disabled={busy}
                      onClick={() =>
                        void apply(() =>
                          api.trustExternalAgent(project.id, agent.scope, agent.name, !trusted),
                        )
                      }
                    >
                      {trusted ? "사용 중지" : "신뢰"}
                    </Button>
                  </ItemActions>
                )}
              </Item>
            );
          })}
        </ItemGroup>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
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

  if (!project) return <FieldDescription>프로젝트를 먼저 선택하세요.</FieldDescription>;
  if (!catalog) return error ? <FieldDescription>{error}</FieldDescription> : <Spinner />;

  return (
    <FieldGroup>
      <FieldDescription>
        모델은 목록의 이름과 설명을 보고, 작업에 맞으면 내용을 읽어 따라요. skill 문구는 지침일
        뿐이라 승인을 대신하지 않아요. 이름이 같으면 프로젝트 → 공통 → 기본 순으로 앞의 것이 쓰이니,
        기본 skill도 같은 이름으로 덮어쓸 수 있어요.
      </FieldDescription>
      <div className="flex flex-col gap-1">
        {catalog.directories.map((directory) => (
          <div key={directory.scope} className="text-xs text-muted-foreground">
            {skillScopeLabels[directory.scope]}: <code className="break-all">{directory.path}</code>
          </div>
        ))}
      </div>
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
                <ItemDescription lines={3}>{skill.description}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      {catalog.problems.map((problem) => (
        <FieldError key={problem.directory}>
          <code className="break-all">{problem.directory}</code>: {skillProblems[problem.problem]}
        </FieldError>
      ))}
    </FieldGroup>
  );
}

/** Settings that apply beyond one conversation: web search, MCP servers, skills and agents. */
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>대화 밖에서 쓰는 도구와 연결을 관리해요.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="web">
          <TabsList>
            <TabsTrigger value="web">웹 검색</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="agents">에이전트</TabsTrigger>
            <TabsTrigger value="imports">가져오기</TabsTrigger>
          </TabsList>
          <TabsContent value="web" className="mt-3">
            <KagiSettings />
          </TabsContent>
          <TabsContent value="mcp" className="mt-3 max-h-[60vh] overflow-x-hidden overflow-y-auto">
            <McpSettings project={project} />
          </TabsContent>
          <TabsContent
            value="skills"
            className="mt-3 max-h-[60vh] overflow-x-hidden overflow-y-auto"
          >
            <SkillSettings project={project} />
          </TabsContent>
          <TabsContent
            value="agents"
            className="mt-3 max-h-[60vh] overflow-x-hidden overflow-y-auto"
          >
            <AgentSettings project={project} />
          </TabsContent>
          <TabsContent
            value="imports"
            className="mt-3 max-h-[60vh] overflow-x-hidden overflow-y-auto"
          >
            <ImportSettings />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
