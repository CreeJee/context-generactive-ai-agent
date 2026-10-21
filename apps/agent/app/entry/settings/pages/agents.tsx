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
  type ConfigProblem,
} from "../shared";

function AgentStateBadge({ agent }: { agent: ExternalAgentView }) {
  if (agent.shadowed) return shadowedBadge;
  return AgentTrustState.$match(agent.state, {
    untrusted: () => <Badge variant="outline">신뢰 필요</Badge>,
    changed: () => <Badge variant="destructive">설정 바뀜, 다시 신뢰 필요</Badge>,
    trusted: ({ link }) =>
      AgentLinkState.$match(link, {
        idle: () => <Badge variant="secondary">쓸 때 시작</Badge>,
        connecting: () => <Badge variant="secondary">연결 중</Badge>,
        connected: () => <Badge>연결됨</Badge>,
        retrying: ({ failures }) => <Badge variant="outline">연결 실패 {failures}회</Badge>,
        stopped: () => <Badge variant="destructive">재연결 중단</Badge>,
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
        stopped: ({ failure }): ConfigProblem => ({
          text: `${externalAgentFailureText[failure.code]} 두 번 연달아 실패해서 멈췄어요. 다시 연결을 눌러 주세요.`,
          detail: failure.detail,
        }),
      }),
  });
}

/** External ACP agents (Codex and others) the conversation may delegate to (R17). */
const description =
  "신뢰한 ACP 에이전트에게 모델이 작업을 맡길 수 있어요. 맡길 때마다 승인하고, 에이전트는 이 앱의 ChatGPT 로그인이 아니라 자기 로그인으로 일해요.";

export function AgentSettings({ project }: { project: Project | null }) {
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={"외부 에이전트"} description={description} />
        <NoProject />
      </FieldGroup>
    );
  return <AgentSettingsContent project={project} />;
}

function AgentSettingsContent({ project }: { project: Project }) {
  const mutation = useExternalAgentMutation(project?.id ?? "");
  const { data: overview } = useSuspenseAgentsQuery(project.id);
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const header = <PageHeader title="외부 에이전트" project={project} description={description} />;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const apply = (change: Parameters<typeof mutation.mutateAsync>[0]) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync(change)).pipe(
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
      {overview.agents.length === 0 ? (
        <FieldDescription>설정된 에이전트가 없어요.</FieldDescription>
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
                          onClick={() => void apply(AgentChange.reconnect({ name: agent.name }))}
                        >
                          <RefreshCwIcon /> 다시 연결
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
