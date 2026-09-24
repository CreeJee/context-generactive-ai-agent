import { PlugIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { ItemDescription, ItemGroup } from "~/components/ui/item";
import { type McpServerView, type Project } from "../../api";
import { useSuspenseMcpQuery } from "../../queries/project";
import { useMcpTrustMutation } from "../../queries/mutations/project";
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
const description =
  "신뢰한 서버만 시작해요. 설정 파일이 바뀌면 다시 신뢰해야 하고, 신뢰해도 도구를 부를 때마다 승인이나 자동 판단을 거쳐요.";

export function McpSettings({ project }: { project: Project | null }) {
  if (!project)
    return (
      <FieldGroup>
        <PageHeader title={"MCP 서버"} description={description} />
        <NoProject />
      </FieldGroup>
    );
  return <McpSettingsContent project={project} />;
}

function McpSettingsContent({ project }: { project: Project }) {
  const mutation = useMcpTrustMutation(project?.id ?? "");
  const { data: overview } = useSuspenseMcpQuery(project.id);
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);

  const header = <PageHeader title="MCP 서버" project={project} description={description} />;
  const trust = async (server: McpServerView, trusted: boolean) => {
    setError(null);
    try {
      await mutation.mutateAsync({ scope: server.scope, name: server.name, trusted });
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
