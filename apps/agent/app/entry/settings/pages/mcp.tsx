import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { PlugIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { ItemDescription, ItemGroup } from "~/components/ui/item";
import type { McpFailureCode, McpLoginFailureCode } from "memory-agent/definitions";
import { McpCommand, McpServerState, type McpServerView, type Project } from "../../api";
import { useSuspenseMcpQuery } from "../../queries/project";
import { useMcpMutation } from "../../queries/mutations/project";
import {
  PageHeader,
  PageError,
  NoProject,
  pathIn,
  SourceFiles,
  scopeLabels,
  ConfigEntry,
  TrustButton,
  shadowedBadge,
} from "../shared";

function McpStateBadge({ server }: { server: McpServerView }) {
  if (server.shadowed) return shadowedBadge;
  return McpServerState.$match(server.state, {
    untrusted: () => <Badge variant="outline">신뢰 필요</Badge>,
    changed: () => <Badge variant="destructive">설정 바뀜, 다시 신뢰 필요</Badge>,
    trusted: () => <Badge variant="secondary">다음 대화에서 시작</Badge>,
    connected: ({ tools }) => <Badge>도구 {tools.length}개</Badge>,
    failed: () => <Badge variant="destructive">시작 실패</Badge>,
    needsLogin: () => <Badge variant="outline">로그인 필요</Badge>,
    loggingIn: () => <Badge variant="secondary">브라우저에서 로그인 중</Badge>,
  });
}

const mcpFailureText = {
  missing_env: "설정이 쓰는 환경 변수가 없어요.",
  connect_timed_out: "서버가 제시간에 연결되지 않았어요.",
  tools_list_timed_out: "서버가 제시간에 도구 목록을 주지 않았어요.",
  start_failed: "서버를 시작하거나 연결하지 못했어요.",
} as const satisfies Record<McpFailureCode, string>;

const mcpLoginFailureText = {
  callback_port_unavailable:
    "로그인 후 돌아올 포트를 열지 못했어요. 다른 프로그램이 쓰고 있을 수 있어요.",
  login_timed_out: "로그인이 제시간에 끝나지 않았어요.",
  login_denied: "로그인이 거절됐어요.",
  login_failed: "로그인하지 못했어요.",
} as const satisfies Record<McpLoginFailureCode, string>;

/** What went wrong with a server, with its own text on request. */
const problemOf = (state: McpServerState) =>
  McpServerState.$is("failed")(state)
    ? { text: mcpFailureText[state.failure.code], detail: state.failure.detail }
    : McpServerState.$is("needsLogin")(state) && state.failure !== null
      ? { text: mcpLoginFailureText[state.failure.code], detail: state.failure.detail }
      : null;

/** MCP servers from the user-wide and project config files (R18). */
const description =
  "신뢰한 서버만 시작해요. 설정 파일이 바뀌면 다시 신뢰해야 하고, 신뢰해도 도구를 부를 때마다 승인이나 자동 판단을 거쳐요.";

export function McpSettings({ project }: { project: Project | null }) {
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={"MCP 서버"} description={description} />
        <NoProject />
      </FieldGroup>
    );
  return <McpSettingsContent project={project} />;
}

function McpSettingsContent({ project }: { project: Project }) {
  const mutation = useMcpMutation(project?.id ?? "");
  const { data: overview } = useSuspenseMcpQuery(project.id);
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const header = <PageHeader title="MCP 서버" project={project} description={description} />;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const run = (command: McpCommand) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync(command)).pipe(
          Effect.catchTag("UnknownError", (_failure) =>
            Effect.sync(() => {
              setError("바꾸지 못했어요.");
            }),
          ),
        );
      }),
    );

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
            const active =
              !McpServerState.$is("untrusted")(server.state) &&
              !McpServerState.$is("changed")(server.state);
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
                problem={problemOf(server.state)}
                actions={
                  !server.shadowed && (
                    <>
                      <LoginActions server={server} busy={busy} run={run} />
                      <TrustButton
                        active={active}
                        changed={McpServerState.$is("changed")(server.state)}
                        busy={busy}
                        onClick={() =>
                          void run(
                            McpCommand.trust({
                              scope: server.scope,
                              name: server.name,
                              trusted: !active,
                            }),
                          )
                        }
                      />
                    </>
                  )
                }
              >
                {McpServerState.$is("connected")(server.state) && server.state.tools.length > 0 && (
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

/** A server's OAuth login: start it, open it in the browser, stop it, or forget it. */
function LoginActions({
  server,
  busy,
  run,
}: {
  server: McpServerView;
  busy: boolean;
  run: (command: McpCommand) => Promise<void>;
}) {
  const target = { scope: server.scope, name: server.name };
  if (McpServerState.$is("loggingIn")(server.state))
    return (
      <>
        <a
          className={buttonVariants({ size: "sm" })}
          href={server.state.authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          브라우저에서 로그인
        </a>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void run(McpCommand.cancelLogin(target))}
        >
          로그인 취소
        </Button>
      </>
    );
  return (
    <>
      {(McpServerState.$is("needsLogin")(server.state) || server.signedIn) && (
        <Button
          size="sm"
          variant={server.signedIn ? "ghost" : "default"}
          disabled={busy}
          onClick={() => void run(McpCommand.login(target))}
        >
          {server.signedIn ? "다시 로그인" : "로그인"}
        </Button>
      )}
      {server.signedIn && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void run(McpCommand.logout(target))}
        >
          로그아웃
        </Button>
      )}
    </>
  );
}
