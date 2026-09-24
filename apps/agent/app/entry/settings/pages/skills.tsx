import { BookOpenIcon } from "lucide-react";
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
import { type Project } from "../../api";
import { useSuspenseSkillsQuery } from "../../queries/project";
import { PageHeader, NoProject, pathIn, SourceFiles, skillScopeLabels } from "../shared";

const skillProblems = {
  no_description: "description이 없어 쓰지 않아요.",
  too_large: "SKILL.md가 너무 커서 쓰지 않아요.",
  unreadable: "읽지 못했어요.",
} as const;

/** Skills the model can read in this project (R18). They are instructions, not permissions. */
const description =
  "모델이 이름과 설명을 보고 작업에 맞는 skill을 읽어 따라요. skill은 지침일 뿐이라 승인을 대신하지 않아요.";

export function SkillSettings({ project }: { project: Project | null }) {
  if (!project)
    return (
      <FieldGroup>
        <PageHeader title={"Skills"} description={description} />
        <NoProject />
      </FieldGroup>
    );
  return <SkillSettingsContent project={project} />;
}

function SkillSettingsContent({ project }: { project: Project }) {
  const { data: catalog } = useSuspenseSkillsQuery(project.id);

  const header = (
    <PageHeader
      title="Skills"
      project={project}
      badge={catalog && <Badge variant="secondary">{catalog.skills.length}개</Badge>}
      description={description}
    />
  );

  return (
    <FieldGroup>
      {header}
      <SourceFiles
        files={catalog.directories.map((directory) => ({
          label: skillScopeLabels[directory.scope],
          path: directory.path,
          shown: pathIn(project, directory.path),
        }))}
        note="이름이 같으면 프로젝트, 공통, 기본 순으로 앞의 것을 써요. 기본 skill도 같은 이름으로 덮어쓸 수 있어요."
      />
      {catalog.problems.map((problem) => (
        <FieldError key={problem.directory}>
          <code className="break-all">{pathIn(project, problem.directory)}</code>:{" "}
          {skillProblems[problem.problem]}
        </FieldError>
      ))}
      {catalog.skills.length === 0 ? (
        <FieldDescription>쓸 수 있는 skill이 없어요.</FieldDescription>
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
                  <Badge variant="secondary">{skillScopeLabels[skill.scope]}</Badge>
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
