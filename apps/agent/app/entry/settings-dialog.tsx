import {
  BookOpenIcon,
  BotIcon,
  KeyRoundIcon,
  PlugIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
        <ItemTitle className="flex flex-wrap items-center gap-1.5">
          {server.name}
          <Badge variant="secondary">{scopeLabels[server.scope]}</Badge>
          <McpStateBadge server={server} />
        </ItemTitle>
        <ItemDescription className="font-mono break-all">{server.target}</ItemDescription>
        {names.length > 0 && (
          <ItemDescription>
            {server.transport === "stdio" ? "환경 변수" : "헤더"}: {names.join(", ")} (값은 보여주지
            않아요)
          </ItemDescription>
        )}
        {server.state.status === "failed" && (
          <ItemDescription className="text-destructive">{server.state.error}</ItemDescription>
        )}
        {server.state.status === "connected" && server.state.tools.length > 0 && (
          <ItemDescription className="font-mono">{server.state.tools.join(", ")}</ItemDescription>
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
        <ItemGroup className="gap-2">
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
        <ItemGroup className="gap-2">
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
                  <ItemTitle className="flex flex-wrap items-center gap-1.5">
                    {agent.name}
                    <Badge variant="secondary">{scopeLabels[agent.scope]}</Badge>
                    <AgentStateBadge agent={agent} />
                  </ItemTitle>
                  <ItemDescription className="font-mono break-all">{agent.target}</ItemDescription>
                  {agent.envNames.length > 0 && (
                    <ItemDescription>
                      환경 변수: {agent.envNames.join(", ")} (값은 보여주지 않아요)
                    </ItemDescription>
                  )}
                  {agent.state.status === "trusted" &&
                    (agent.state.link.status === "retrying" ||
                      agent.state.link.status === "stopped") && (
                      <ItemDescription className="text-destructive">
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
        뿐이라 승인을 대신하지 않아요. 같은 이름이면 프로젝트 skill이 쓰여요.
      </FieldDescription>
      <div className="flex flex-col gap-1">
        {catalog.directories.map((directory) => (
          <div key={directory.scope} className="text-xs text-muted-foreground">
            {scopeLabels[directory.scope]}: <code className="break-all">{directory.path}</code>
          </div>
        ))}
      </div>
      {catalog.skills.length === 0 ? (
        <FieldDescription>쓸 수 있는 skill이 없어요.</FieldDescription>
      ) : (
        <ItemGroup className="gap-2">
          {catalog.skills.map((skill) => (
            <Item key={`${skill.scope}/${skill.name}`} variant="outline" size="sm">
              <ItemMedia variant="icon">
                <BookOpenIcon />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="flex items-center gap-1.5">
                  {skill.name}
                  <Badge variant="secondary">{scopeLabels[skill.scope]}</Badge>
                </ItemTitle>
                <ItemDescription className="line-clamp-3">{skill.description}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      {catalog.problems.map((problem) => (
        <FieldDescription key={problem.directory} className="text-destructive">
          <code className="break-all">{problem.directory}</code>: {skillProblems[problem.problem]}
        </FieldDescription>
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
          </TabsList>
          <TabsContent value="web" className="pt-3">
            <KagiSettings />
          </TabsContent>
          <TabsContent value="mcp" className="max-h-[60vh] overflow-y-auto pt-3">
            <McpSettings project={project} />
          </TabsContent>
          <TabsContent value="skills" className="max-h-[60vh] overflow-y-auto pt-3">
            <SkillSettings project={project} />
          </TabsContent>
          <TabsContent value="agents" className="max-h-[60vh] overflow-y-auto pt-3">
            <AgentSettings project={project} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
