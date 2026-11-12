import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { isTruthy } from "../../../truthy.ts";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { refusalOf, type PermissionMode, type Project } from "../../api";
import { usePermissionModeMutation } from "../../queries/mutations/project";
import { errorMessage, NoProject, PageError, PageHeader, pageTitles } from "../shared";

const description = msg({
  message:
    "에이전트가 승인을 받던 도구(셸 명령, 프로젝트 밖의 파일 저장 등)를 어떻게 허용할지 정합니다. 자동 판단은 도구마다 허용·질문·거부를 먼저 판단합니다.",
  comment: "Description of the project permission mode settings page",
});

const permissionModeLabels = {
  ask: msg({ message: "매번 묻기", comment: "Project permission mode `ask`" }),
  auto: msg({ message: "자동 판단 (auto)", comment: "Project permission mode `auto`" }),
  full: msg({ message: "전체 권한 (full)", comment: "Project permission mode `full`" }),
} satisfies Record<PermissionMode, MessageDescriptor>;

const permissionModes = [
  { value: "ask", label: permissionModeLabels.ask },
  { value: "auto", label: permissionModeLabels.auto },
  { value: "full", label: permissionModeLabels.full },
] satisfies ReadonlyArray<{ value: PermissionMode; label: MessageDescriptor }>;

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
  const mutation = usePermissionModeMutation(project.id);
  const [error, setError] = useState<string | null>(null);
  // Full permission runs every tool without asking, so it is confirmed first.
  const [confirmingFull, setConfirmingFull] = useState(false);
  const modeItems = permissionModes.map((option) => ({
    value: option.value,
    label: t(option.label),
  }));

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const setMode = (mode: PermissionMode) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        yield* uiPromise(() => mutation.mutateAsync(mode)).pipe(
          Effect.catchTag("UnknownError", (failure) =>
            Effect.sync(() => setError(errorMessage(refusalOf(failure.cause)))),
          ),
        );
      }),
    );

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
        <Select
          value={project.permissionMode}
          items={modeItems}
          disabled={mutation.isPending}
          onValueChange={(value) => {
            const mode = permissionModes.find((option) => option.value === value);
            if (mode?.value === "full") setConfirmingFull(true);
            else if (isTruthy(mode)) void setMode(mode.value);
          }}
        >
          <SelectTrigger
            id="project-permission-mode"
            className="w-36"
            aria-label={t({
              message: "권한 모드",
              comment: "Picker of the project's permission mode",
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modeItems.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <PageError error={error} />
      <AlertDialog open={confirmingFull} onOpenChange={setConfirmingFull}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>전체 권한으로 바꿀까요?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                이 프로젝트의 대화가 셸 명령과 MCP 도구처럼 승인을 받던 도구를 묻지 않고 바로
                실행합니다. 믿을 수 있는 프로젝트에서만 써 주십시오.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans comment="Dialog button that cancels">취소</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmingFull(false);
                void setMode("full");
              }}
            >
              <Trans comment="Dialog button that confirms switching the project to full permission">
                전체 권한으로 바꾸기
              </Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldGroup>
  );
}
