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
import { settingsCopy } from "../copy";

const copy = settingsCopy.agents;
const sharedCopy = settingsCopy.shared;

function AgentStateBadge({ agent }: { agent: ExternalAgentView }) {
  if (agent.shadowed) return shadowedBadge;
  return AgentTrustState.$match(agent.state, {
    untrusted: () => <Badge variant="outline">{sharedCopy.trustBadges.untrusted}</Badge>,
    changed: () => <Badge variant="destructive">{sharedCopy.trustBadges.changed}</Badge>,
    trusted: ({ link }) =>
      AgentLinkState.$match(link, {
        idle: () => <Badge variant="secondary">{copy.link.idle}</Badge>,
        connecting: () => <Badge variant="secondary">{copy.link.connecting}</Badge>,
        connected: () => <Badge>{copy.link.connected}</Badge>,
        retrying: ({ failures }) => <Badge variant="outline">{copy.link.retrying(failures)}</Badge>,
        stopped: () => <Badge variant="destructive">{copy.link.stopped}</Badge>,
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
          text: copy.stoppedProblem(externalAgentFailureText[failure.code]),
          detail: failure.detail,
        }),
      }),
  });
}

/** External ACP agents (Codex and others) the conversation may delegate to (R17). */
export function AgentSettings({ project }: { project: Project | null }) {
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={settingsCopy.titles.agents} description={copy.description} />
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

  const header = (
    <PageHeader
      title={settingsCopy.titles.agents}
      project={project}
      description={copy.description}
    />
  );
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const apply = (change: Parameters<typeof mutation.mutateAsync>[0]) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync(change)).pipe(
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
      {overview.agents.length === 0 ? (
        <FieldDescription>{copy.empty}</FieldDescription>
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
                secretKind={sharedCopy.secretKinds.env}
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
                          <RefreshCwIcon /> {copy.reconnect}
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
