import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { PlugIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { ItemDescription, ItemGroup } from "~/components/ui/item";
import type { McpFailureCode, McpLoginFailureCode } from "memory-agent/definitions";
import { Spinner } from "~/components/ui/spinner";
import { McpCommand, McpServerState, refusalOf, type McpServerView, type Project } from "../../api";
import { useSuspenseMcpQuery } from "../../queries/project";
import { useMcpMutation } from "../../queries/mutations/project";
import {
  errorMessage,
  PageHeader,
  PageError,
  NoProject,
  pathIn,
  SourceFiles,
  scopeLabels,
  ConfigEntry,
  TrustButton,
  shadowedBadge,
  pageTitles,
} from "../shared";

const description = msg`신뢰한 서버만 시작합니다. 설정 파일이 바뀌면 다시 신뢰해야 합니다. 신뢰해도 도구를 부를 때마다 승인이나 자동 판단을 거칩니다.`;

const failures = {
  missing_env: msg`설정이 쓰는 환경 변수가 없습니다.`,
  connect_timed_out: msg`서버가 제시간에 연결되지 않았습니다.`,
  tools_list_timed_out: msg`서버가 제시간에 도구 목록을 주지 않았습니다.`,
  start_failed: msg`서버를 시작하거나 연결하지 못했습니다.`,
} satisfies Record<McpFailureCode, MessageDescriptor>;

const loginFailures = {
  callback_port_unavailable: msg`로그인 후 돌아올 포트를 열지 못했습니다. 다른 프로그램이 쓰고 있을 수 있습니다.`,
  login_timed_out: msg`로그인이 제시간에 끝나지 않았습니다.`,
  login_denied: msg`로그인이 거절됐습니다.`,
  login_failed: msg`로그인하지 못했습니다.`,
} satisfies Record<McpLoginFailureCode, MessageDescriptor>;

function McpStateBadge({ server }: { server: McpServerView }) {
  if (server.shadowed) return shadowedBadge;
  return McpServerState.$match(server.state, {
    untrusted: () => (
      <Badge variant="outline">
        <Trans comment="Badge on an MCP server or agent the user has not trusted yet">
          신뢰 필요
        </Trans>
      </Badge>
    ),
    changed: () => (
      <Badge variant="destructive">
        <Trans comment="Badge on an MCP server or agent whose config changed after it was trusted">
          설정 바뀜, 다시 신뢰 필요
        </Trans>
      </Badge>
    ),
    trusted: () => (
      <Badge variant="secondary">
        <Trans comment="Badge on a trusted MCP server that starts with the next conversation">
          다음 대화에서 시작
        </Trans>
      </Badge>
    ),
    connected: ({ tools }) => {
      const count = tools.length;
      return (
        <Badge>
          <Trans comment="Badge on a connected MCP server; {count} is how many tools it offers">
            도구 {count}개
          </Trans>
        </Badge>
      );
    },
    failed: () => (
      <Badge variant="destructive">
        <Trans comment="Badge on an MCP server that failed to start">시작 실패</Trans>
      </Badge>
    ),
    needsLogin: () => (
      <Badge variant="outline">
        <Trans comment="Badge on an MCP server that needs an OAuth login">로그인 필요</Trans>
      </Badge>
    ),
    loggingIn: () => (
      <Badge variant="secondary">
        <Trans comment="Badge on an MCP server whose OAuth login is open in the browser">
          브라우저에서 로그인 중
        </Trans>
      </Badge>
    ),
  });
}

/** What went wrong with a server, with its own text on request. */
const problemOf = (state: McpServerState) =>
  McpServerState.$is("failed")(state)
    ? { text: i18n._(failures[state.failure.code]), detail: state.failure.detail }
    : McpServerState.$is("needsLogin")(state) && state.failure !== null
      ? { text: i18n._(loginFailures[state.failure.code]), detail: state.failure.detail }
      : null;

/** MCP servers from the user-wide and project config files (R18). */
export function McpSettings({ project }: { project: Project | null }) {
  const { t } = useLingui();
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={t(pageTitles.mcp)} description={t(description)} />
        <NoProject />
      </FieldGroup>
    );
  return <McpSettingsContent project={project} />;
}

function McpSettingsContent({ project }: { project: Project }) {
  const { t } = useLingui();
  const mutation = useMcpMutation(project?.id ?? "");
  const { data: overview } = useSuspenseMcpQuery(project.id);
  const [error, setError] = useState<string | null>(null);
  // Starting a trusted server can take a while, so only the row being changed waits for it.
  const [pending, setPending] = useState<readonly string[]>([]);

  const header = (
    <PageHeader title={t(pageTitles.mcp)} project={project} description={t(description)} />
  );
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const run = (row: string, command: McpCommand) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        setPending((rows) => [...rows, row]);
        yield* uiPromise(() => mutation.mutateAsync(command)).pipe(
          Effect.catchTag("UnknownError", (failure) =>
            Effect.sync(() => setError(errorMessage(refusalOf(failure.cause)))),
          ),
          Effect.ensuring(
            Effect.sync(() => setPending((rows) => rows.filter((item) => item !== row))),
          ),
        );
      }),
    );

  return (
    <FieldGroup>
      {header}
      <SourceFiles
        files={overview.files.map((file) => ({
          label: t(scopeLabels[file.scope]),
          path: file.path,
          shown: pathIn(project, file.path),
          error: file.error,
        }))}
        note={<Trans>이름이 같으면 프로젝트 설정을 씁니다.</Trans>}
      />
      {overview.servers.length === 0 ? (
        <FieldDescription>
          <Trans>설정된 MCP 서버가 없습니다.</Trans>
        </FieldDescription>
      ) : (
        <ItemGroup>
          {overview.servers.map((server) => {
            const row = `${server.scope}/${server.name}`;
            const busy = pending.includes(row);
            const active =
              !McpServerState.$is("untrusted")(server.state) &&
              !McpServerState.$is("changed")(server.state);
            return (
              <ConfigEntry
                key={row}
                icon={<PlugIcon />}
                name={server.name}
                scope={server.scope}
                state={<McpStateBadge server={server} />}
                target={server.target}
                secretKind={
                  server.transport === "stdio"
                    ? t({
                        message: "환경 변수",
                        comment: "Kind of secret whose names an entry lists: environment variables",
                      })
                    : t({
                        message: "헤더",
                        comment: "Kind of secret whose names an entry lists: HTTP headers",
                      })
                }
                secretNames={[...server.envNames, ...server.headerNames]}
                problem={problemOf(server.state)}
                actions={
                  !server.shadowed && (
                    <>
                      {busy && <Spinner />}
                      <LoginActions
                        server={server}
                        busy={busy}
                        run={(command) => run(row, command)}
                      />
                      {McpServerState.$is("failed")(server.state) && (
                        // Trusting again starts a failed server now instead of in the next conversation.
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              row,
                              McpCommand.trust({
                                scope: server.scope,
                                name: server.name,
                                trusted: true,
                              }),
                            )
                          }
                        >
                          <RefreshCwIcon />{" "}
                          <Trans comment="Button that starts an MCP server again after it failed to start">
                            다시 시작
                          </Trans>
                        </Button>
                      )}
                      <TrustButton
                        active={active}
                        changed={McpServerState.$is("changed")(server.state)}
                        busy={busy}
                        onClick={() =>
                          void run(
                            row,
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
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const target = { scope: server.scope, name: server.name };
  const serverName = server.name;
  if (McpServerState.$is("loggingIn")(server.state))
    return (
      <>
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={server.state.authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Trans comment="Link that opens an MCP server's OAuth login page in the browser">
            브라우저에서 로그인
          </Trans>
        </a>
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={busy}
          onClick={() => void run(McpCommand.cancelLogin(target))}
        >
          <Trans comment="Button that cancels an MCP server's OAuth login in progress">
            로그인 취소
          </Trans>
        </Button>
      </>
    );
  return (
    <>
      {(McpServerState.$is("needsLogin")(server.state) || server.signedIn) && (
        <Button
          size="sm"
          variant={server.signedIn ? "ghost-muted" : "outline"}
          disabled={busy}
          onClick={() => void run(McpCommand.login(target))}
        >
          {server.signedIn ? (
            <Trans comment="Button that signs in to an MCP server again">다시 로그인</Trans>
          ) : (
            <Trans comment="Button that signs in to an MCP server">로그인</Trans>
          )}
        </Button>
      )}
      {server.signedIn && (
        <AlertDialog open={confirmingLogout} onOpenChange={setConfirmingLogout}>
          <AlertDialogTrigger render={<Button size="sm" variant="ghost-muted" disabled={busy} />}>
            <Trans comment="Button that signs out of an MCP server">로그아웃</Trans>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>{serverName} 서버에서 로그아웃할까요?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>
                  저장한 로그인 정보를 지웁니다. 이 서버를 다시 쓰려면 다시 로그인해야 합니다.
                </Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <Trans comment="Dialog button that cancels">취소</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirmingLogout(false);
                  void run(McpCommand.logout(target));
                }}
              >
                <Trans comment="Dialog button that confirms signing out of an MCP server">
                  로그아웃
                </Trans>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
