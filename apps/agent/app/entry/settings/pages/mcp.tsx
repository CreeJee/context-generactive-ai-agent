import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { PlugIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { ItemDescription, ItemGroup } from "~/components/ui/item";
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
import { settingsCopy } from "../copy";

const copy = settingsCopy.mcp;
const sharedCopy = settingsCopy.shared;

function McpStateBadge({ server }: { server: McpServerView }) {
  if (server.shadowed) return shadowedBadge;
  return McpServerState.$match(server.state, {
    untrusted: () => <Badge variant="outline">{sharedCopy.trustBadges.untrusted}</Badge>,
    changed: () => <Badge variant="destructive">{sharedCopy.trustBadges.changed}</Badge>,
    trusted: () => <Badge variant="secondary">{copy.state.trusted}</Badge>,
    connected: ({ tools }) => <Badge>{copy.state.connected(tools.length)}</Badge>,
    failed: () => <Badge variant="destructive">{copy.state.failed}</Badge>,
    needsLogin: () => <Badge variant="outline">{copy.state.needsLogin}</Badge>,
    loggingIn: () => <Badge variant="secondary">{copy.state.loggingIn}</Badge>,
  });
}

/** What went wrong with a server, with its own text on request. */
const problemOf = (state: McpServerState) =>
  McpServerState.$is("failed")(state)
    ? { text: copy.failures[state.failure.code], detail: state.failure.detail }
    : McpServerState.$is("needsLogin")(state) && state.failure !== null
      ? { text: copy.loginFailures[state.failure.code], detail: state.failure.detail }
      : null;

/** MCP servers from the user-wide and project config files (R18). */
export function McpSettings({ project }: { project: Project | null }) {
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={settingsCopy.titles.mcp} description={copy.description} />
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

  const header = (
    <PageHeader title={settingsCopy.titles.mcp} project={project} description={copy.description} />
  );
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const run = (command: McpCommand) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync(command)).pipe(
          Effect.catchTag("UnknownError", (_failure) =>
            Effect.sync(() => {
              setError(sharedCopy.changeFailed);
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
        note={sharedCopy.projectWins}
      />
      {overview.servers.length === 0 ? (
        <FieldDescription>{copy.empty}</FieldDescription>
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
                secretKind={
                  server.transport === "stdio"
                    ? sharedCopy.secretKinds.env
                    : sharedCopy.secretKinds.headers
                }
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
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={server.state.authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {copy.loginInBrowser}
        </a>
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={busy}
          onClick={() => void run(McpCommand.cancelLogin(target))}
        >
          {copy.cancelLogin}
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
          {server.signedIn ? copy.loginAgain : copy.login}
        </Button>
      )}
      {server.signedIn && (
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={busy}
          onClick={() => void run(McpCommand.logout(target))}
        >
          {copy.logout}
        </Button>
      )}
    </>
  );
}
