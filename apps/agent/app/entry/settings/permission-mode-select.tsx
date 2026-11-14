import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { isTruthy } from "../../truthy.ts";
import { refusalOf, type PermissionMode, type Project } from "../api";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { usePermissionModeMutation } from "../queries/mutations/project";
import { errorMessage } from "./shared";

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

/**
 * Picks how the project's conversations allow tools that would ask for approval (ask/auto/full).
 * Full permission is confirmed first, because it runs every tool without asking.
 */
export function PermissionModeSelect({
  project,
  id,
  size,
  onError,
}: {
  readonly project: Project;
  /** The trigger's id, for a label. */
  readonly id?: string;
  /** The trigger's size; the composer uses the small one. */
  readonly size?: "sm" | "default";
  /** Why the change was refused. */
  readonly onError: (message: string | null) => void;
}) {
  const { t } = useLingui();
  const mutation = usePermissionModeMutation(project.id);
  const [confirmingFull, setConfirmingFull] = useState(false);
  const modeItems = permissionModes.map((option) => ({
    value: option.value,
    label: t(option.label),
  }));

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const setMode = (mode: PermissionMode) =>
    runUiEffect(
      Effect.gen(function* () {
        onError(null);
        yield* uiPromise(() => mutation.mutateAsync(mode)).pipe(
          Effect.catchTag("UnknownError", (failure) =>
            Effect.sync(() => onError(errorMessage(refusalOf(failure.cause)))),
          ),
        );
      }),
    );

  return (
    <>
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
          id={id}
          size={size}
          className={size === "sm" ? undefined : "w-36"}
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
    </>
  );
}
