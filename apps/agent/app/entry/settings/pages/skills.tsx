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
import { settingsCopy } from "../copy";

const copy = settingsCopy.skills;

/** Skills the model can read in this project (R18). They are instructions, not permissions. */
export function SkillSettings({ project }: { project: Project | null }) {
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={settingsCopy.titles.skills} description={copy.description} />
        <NoProject />
      </FieldGroup>
    );
  return <SkillSettingsContent project={project} />;
}

function SkillSettingsContent({ project }: { project: Project }) {
  const { data: catalog } = useSuspenseSkillsQuery(project.id);

  const header = (
    <PageHeader
      title={settingsCopy.titles.skills}
      project={project}
      badge={catalog && <Badge variant="secondary">{copy.count(catalog.skills.length)}</Badge>}
      description={copy.description}
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
        note={copy.sourceNote}
      />
      {catalog.problems.map((problem) => (
        <FieldError key={problem.directory}>
          <code className="break-all">{pathIn(project, problem.directory)}</code>:{" "}
          {copy.problems[problem.problem]}
        </FieldError>
      ))}
      {catalog.skills.length === 0 ? (
        <FieldDescription>{copy.empty}</FieldDescription>
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
