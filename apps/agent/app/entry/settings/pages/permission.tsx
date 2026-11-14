import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import type { Project } from "../../api";
import { PermissionModeSelect } from "../permission-mode-select";
import { NoProject, PageError, PageHeader, pageTitles } from "../shared";

const description = msg({
  message:
    "에이전트가 승인을 받던 도구(셸 명령, 프로젝트 밖의 파일 저장 등)를 어떻게 허용할지 정합니다. 자동 판단은 도구마다 허용·질문·거부를 먼저 판단합니다.",
  comment: "Description of the project permission mode settings page",
});

/** How the project's conversations allow tools that would ask for approval (ask/auto/full). */
export function PermissionSettings({ project }: { project: Project | null }) {
  const { t } = useLingui();
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={t(pageTitles.permission)} description={t(description)} />
        <NoProject />
      </FieldGroup>
    );
  return <PermissionSettingsContent project={project} />;
}

function PermissionSettingsContent({ project }: { project: Project }) {
  const { t } = useLingui();
  const [error, setError] = useState<string | null>(null);

  return (
    <FieldGroup>
      <PageHeader title={t(pageTitles.permission)} project={project} description={t(description)} />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="project-permission-mode">
            <Trans comment="Field label: the project's permission mode">권한 모드</Trans>
          </FieldLabel>
          <FieldDescription>
            <Trans comment="Description of the project's permission mode field">
              이 프로젝트의 대화가 도구를 부를 때 따르는 권한 모드입니다. 바꾸면 다음 도구 호출부터
              적용됩니다.
            </Trans>
          </FieldDescription>
        </FieldContent>
        <PermissionModeSelect project={project} id="project-permission-mode" onError={setError} />
      </Field>
      <PageError error={error} />
    </FieldGroup>
  );
}
