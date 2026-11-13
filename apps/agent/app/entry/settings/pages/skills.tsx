import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { BookOpenIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { FieldDescription, FieldError, FieldGroup } from "~/components/ui/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "~/components/ui/item";
import { isApiError, type Project, type SkillCatalog } from "../../api";
import { useSkillRouterQuery } from "../../queries/global";
import { useSkillRouterMutation } from "../../queries/mutations/global";
import { useSuspenseSkillsQuery } from "../../queries/project";
import { ModelSelectionField } from "../model-selection-field";
import {
  PageHeader,
  NoProject,
  pathIn,
  SourceFiles,
  skillScopeLabels,
  pageTitles,
} from "../shared";

const description = msg`모델이 작업에 맞는 skill을 검색해 읽고 따릅니다. skill은 지침일 뿐이라 승인을 대신하지 않습니다.`;

const problems = {
  no_description: msg`description이 없어 쓰지 않습니다.`,
  too_large: msg`SKILL.md가 너무 커서 쓰지 않습니다.`,
  unreadable: msg`읽지 못했습니다.`,
} satisfies Record<SkillCatalog["problems"][number]["problem"], MessageDescriptor>;

/**
 * The model that chooses find_skill's results among the search's, or none for the search's own
 * best. It is the same for every project.
 */
function SkillRouterField() {
  const { t } = useLingui();
  const { data: settings } = useSkillRouterQuery();
  const mutation = useSkillRouterMutation();
  const [error, setError] = useState<string | null>(null);
  return (
    <ModelSelectionField
      id="skill-router-model"
      label={t`skill 고르기 모델`}
      description={
        <Trans>
          모델이 skill을 검색하면, 검색 결과에서 작업에 맞는 것만 이 모델이 골라 줍니다. 검색할
          때마다 이 모델을 한 번 부릅니다. 모든 프로젝트에 같이 쓰입니다.
        </Trans>
      }
      saved={settings.model}
      unsetLabel={t({
        message: "사용 안 함",
        comment: "Option: no model chooses among the skills a search found",
      })}
      unsetNote={<Trans>지금은 쓰지 않고, 검색 순위의 앞쪽을 그대로 줍니다.</Trans>}
      busy={mutation.isPending}
      error={error}
      onSave={(model) => {
        setError(null);
        mutation.mutate(model, {
          onError: (failure) =>
            setError(
              isApiError(failure) && failure.code === "role_model_unavailable"
                ? t`이 모델을 쓸 수 없습니다. 그 제공자 로그인 상태와 모델, 추론 단계가 맞는지 확인해 주십시오.`
                : t`설정을 바꾸지 못했습니다.`,
            ),
        });
      }}
    />
  );
}

/** Skills the model can read in this project (R18). They are instructions, not permissions. */
export function SkillSettings({ project }: { project: Project | null }) {
  const { t } = useLingui();
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={t(pageTitles.skills)} description={t(description)} />
        <NoProject />
      </FieldGroup>
    );
  return <SkillSettingsContent project={project} />;
}

function SkillSettingsContent({ project }: { project: Project }) {
  const { t } = useLingui();
  const { data: catalog } = useSuspenseSkillsQuery(project.id);
  const count = catalog.skills.length;

  const header = (
    <PageHeader
      title={t(pageTitles.skills)}
      project={project}
      badge={
        catalog && (
          <Badge variant="secondary">
            <Trans comment="Badge next to the Skills page title; {count} is how many skills there are">
              {count}개
            </Trans>
          </Badge>
        )
      }
      description={t(description)}
    />
  );

  return (
    <FieldGroup>
      {header}
      <SkillRouterField />
      <SourceFiles
        files={catalog.directories.map((directory) => ({
          label: t(skillScopeLabels[directory.scope]),
          path: directory.path,
          shown: pathIn(project, directory.path),
        }))}
        note={
          <Trans>
            이름이 같으면 프로젝트, 공통, 기본 순으로 앞의 것을 씁니다. 기본 skill도 같은 이름으로
            덮어쓸 수 있습니다.
          </Trans>
        }
      />
      {catalog.problems.map((problem) => (
        <FieldError key={problem.directory}>
          <code className="break-all">{pathIn(project, problem.directory)}</code>:{" "}
          {t(problems[problem.problem])}
        </FieldError>
      ))}
      {catalog.skills.length === 0 ? (
        <FieldDescription>
          <Trans>쓸 수 있는 skill이 없습니다.</Trans>
        </FieldDescription>
      ) : (
        <ItemGroup>
          {catalog.skills.map((skill) => (
            <Item key={`${skill.scope}/${skill.name}`} variant="outline" size="sm">
              <ItemMedia variant="icon">
                <BookOpenIcon />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>
                  {skill.name}
                  <Badge variant="secondary">{t(skillScopeLabels[skill.scope])}</Badge>
                </ItemTitle>
                <ItemDescription>{skill.description}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </FieldGroup>
  );
}

/** The pages of the dialog, in the groups the list on the left shows. */
