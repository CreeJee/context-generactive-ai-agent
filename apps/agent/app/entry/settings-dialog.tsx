import { KeyRoundIcon, PlugIcon, SettingsIcon, Trash2Icon } from "lucide-react";
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
  type KagiStatus,
  type McpOverview,
  type McpServerView,
  type Project,
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

/** Settings that apply beyond one conversation: web search and MCP servers. */
export function SettingsDialog({ project }: { project: Project | null }) {
  return (
    <Dialog>
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
          </TabsList>
          <TabsContent value="web" className="pt-3">
            <KagiSettings />
          </TabsContent>
          <TabsContent value="mcp" className="max-h-[60vh] overflow-y-auto pt-3">
            <McpSettings project={project} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
