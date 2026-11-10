import { msg, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { BotIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { ItemGroup } from "~/components/ui/item";
import { externalAgentFailureText } from "memory-agent/definitions";
import { AgentLinkState, AgentTrustState, type ExternalAgentView, type Project } from "../../api";
import { useSuspenseAgentsQuery } from "../../queries/project";
import { AgentChange, useExternalAgentMutation } from "../../queries/mutations/project";
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
  pageTitles,
  type ConfigProblem,
} from "../shared";

const description = msg`신뢰한 ACP 에이전트에게 모델이 작업을 맡길 수 있습니다. 맡길 때마다 승인합니다. 에이전트는 이 앱의 ChatGPT 로그인이 아니라 자기 로그인으로 일합니다.`;

function AgentStateBadge({ agent }: { agent: ExternalAgentView }) {
  if (agent.shadowed) return shadowedBadge;
  return AgentTrustState.$match(agent.state, {
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
    trusted: ({ link }) =>
      AgentLinkState.$match(link, {
        idle: () => (
          <Badge variant="secondary">
            <Trans comment="Badge on a trusted agent that connects when the conversation first uses it">
              쓸 때 시작
            </Trans>
          </Badge>
        ),
        connecting: () => (
          <Badge variant="secondary">
            <Trans comment="Badge on an agent that is connecting">연결 중</Trans>
          </Badge>
        ),
        connected: () => (
          <Badge>
            <Trans comment="Badge on an agent that is connected">연결됨</Trans>
          </Badge>
        ),
        retrying: ({ failures }) => (
          <Badge variant="outline">
            <Trans comment="Badge on an agent; {failures} is how many connection attempts failed in a row">
              연결 실패 {failures}회
            </Trans>
          </Badge>
        ),
        stopped: () => (
          <Badge variant="destructive">
            <Trans comment="Badge on an agent that stopped reconnecting after repeated failures">
              재연결 중단
            </Trans>
          </Badge>
        ),
      }),
  });
}

/** Why a trusted agent is not connected, when it tried and failed. */
function agentProblem(agent: ExternalAgentView): ConfigProblem | null {
  return AgentTrustState.$match(agent.state, {
    untrusted: () => null,
    changed: () => null,
    trusted: ({ link }) =>
      AgentLinkState.$match(link, {
        idle: () => null,
        connecting: () => null,
        connected: () => null,
        retrying: ({ failure }): ConfigProblem => ({
          text: externalAgentFailureText[failure.code],
          detail: failure.detail,
        }),
        stopped: ({ failure }): ConfigProblem => {
          const reason = externalAgentFailureText[failure.code];
          return {
            text: t`${reason} 두 번 연달아 실패해서 멈췄습니다. 다시 연결을 눌러 주십시오.`,
            detail: failure.detail,
          };
        },
      }),
  });
}

/** External ACP agents (Codex and others) the conversation may delegate to (R17). */
export function AgentSettings({ project }: { project: Project | null }) {
  const { t } = useLingui();
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={t(pageTitles.agents)} description={t(description)} />
        <NoProject />
      </FieldGroup>
    );
  return <AgentSettingsContent project={project} />;
}

function AgentSettingsContent({ project }: { project: Project }) {
  const { t } = useLingui();
  const mutation = useExternalAgentMutation(project?.id ?? "");
  const { data: overview } = useSuspenseAgentsQuery(project.id);
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const header = (
    <PageHeader title={t(pageTitles.agents)} project={project} description={t(description)} />
  );
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const apply = (change: Parameters<typeof mutation.mutateAsync>[0]) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync(change)).pipe(
          Effect.catchTag("UnknownError", (_failure) =>
            Effect.sync(() => {
              setError(t`바꾸지 못했습니다.`);
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
          label: t(scopeLabels[file.scope]),
          path: file.path,
          shown: pathIn(project, file.path),
          error: file.error,
        }))}
        note={<Trans>이름이 같으면 프로젝트 설정을 씁니다.</Trans>}
      />
      {overview.agents.length === 0 ? (
        <FieldDescription>
          <Trans>설정된 에이전트가 없습니다.</Trans>
        </FieldDescription>
      ) : (
        <ItemGroup>
          {overview.agents.map((agent) => {
            const trusted = AgentTrustState.$is("trusted")(agent.state);
            const stopped =
              AgentTrustState.$is("trusted")(agent.state) &&
              AgentLinkState.$is("stopped")(agent.state.link);
            return (
              <ConfigEntry
                key={`${agent.scope}/${agent.name}`}
                icon={<BotIcon />}
                name={agent.name}
                scope={agent.scope}
                state={<AgentStateBadge agent={agent} />}
                target={agent.target}
                secretKind={t({
                  message: "환경 변수",
                  comment: "Kind of secret whose names an entry lists: environment variables",
                })}
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
                          onClick={() => void apply(AgentChange.reconnect({ name: agent.name }))}
                        >
                          <RefreshCwIcon />{" "}
                          <Trans comment="Button that reconnects an agent that stopped retrying">
                            다시 연결
                          </Trans>
                        </Button>
                      )}
                      <TrustButton
                        active={trusted}
                        changed={AgentTrustState.$is("changed")(agent.state)}
                        busy={busy}
                        onClick={() =>
                          void apply(
                            AgentChange.trust({
                              scope: agent.scope,
                              name: agent.name,
                              trusted: !trusted,
                            }),
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
