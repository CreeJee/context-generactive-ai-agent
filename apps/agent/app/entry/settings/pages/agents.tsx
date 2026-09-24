import { BotIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { ItemGroup } from "~/components/ui/item";
import { type ExternalAgentView, type Project } from "../../api";
import { useSuspenseAgentsQuery } from "../../queries/project";
import { useExternalAgentMutation } from "../../queries/mutations/project";
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
const description =
  "신뢰한 ACP 에이전트에게 모델이 작업을 맡길 수 있어요. 맡길 때마다 승인하고, 에이전트는 이 앱의 ChatGPT 로그인이 아니라 자기 로그인으로 일해요.";

export function AgentSettings({ project }: { project: Project | null }) {
  if (!project)
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
  const apply = async (change: Parameters<typeof mutation.mutateAsync>[0]) => {
    setError(null);
    try {
      await mutation.mutateAsync(change);
    } catch {
      setError("바꾸지 못했어요.");
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
                          onClick={() => void apply({ kind: "reconnect", name: agent.name })}
                        >
                          <RefreshCwIcon /> 다시 연결
                        </Button>
                      )}
                      <TrustButton
                        active={trusted}
                        changed={agent.state.status === "changed"}
                        busy={busy}
                        onClick={() =>
                          void apply({
                            kind: "trust",
                            scope: agent.scope,
                            name: agent.name,
                            trusted: !trusted,
                          })
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
