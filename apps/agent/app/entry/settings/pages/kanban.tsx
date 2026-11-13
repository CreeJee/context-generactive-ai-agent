import type { MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Array as Arr, type Cause, Effect, HashMap, Iterable, Option } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { isApiError, type AgentRole, type ApiErrorCode, type Project } from "../../api";
import { useKanbanSettingsQuery, useProjectsQuery } from "../../queries/global";
import {
  useKanbanSettingsMutation,
  useProjectOrderMutation,
  useRoleModelMutation,
} from "../../queries/mutations/global";
import { useProtectedBranchesMutation } from "../../queries/mutations/project";
import { useSuspenseProjectKanbanQuery } from "../../queries/project";
import { PageHeader, PageError, pageTitles } from "../shared";
import { ModelSelectionField } from "../model-selection-field";

/** The most cards the user may let run at once (memory-agent `kanbanConcurrencyLimit`). */
const maximumConcurrency = 32;

const validConcurrency = (text: string) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= maximumConcurrency ? value : null;
};

/** Comma or whitespace separated branch names, without repeats. */
const branchList = (text: string) =>
  Arr.dedupe(text.split(/[\s,]+/u).filter((branch) => branch.length > 0));

/** A failed save that carries no error code this page knows. */
const changeFailed = () => t`설정을 바꾸지 못했습니다.`;

const errorText = (code: ApiErrorCode) => {
  switch (code) {
    case "invalid_kanban_settings":
      return t`값이 올바르지 않습니다. 동시 실행 수는 1~32, 브랜치 이름은 영문·숫자·._/-만 쓸 수 있습니다.`;
    case "project_not_found":
      return t`프로젝트를 찾을 수 없습니다.`;
    case "role_model_unavailable":
      return t`이 모델을 쓸 수 없습니다. 그 제공자 로그인 상태와 모델, 추론 단계가 맞는지 확인해 주십시오.`;
    case "settings_failed":
    case "schedule_storage_failed":
    case "storage_failed":
      return t`설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오.`;
    default:
      return changeFailed();
  }
};

/** The page's wording for a failed save, from the response's error code only. */
const failureText = (failure: Cause.UnknownError) =>
  isApiError(failure.cause) ? errorText(failure.cause.code) : changeFailed();

/** How many kanban cards run at once on this machine, across every Goal. */
function ConcurrencyField() {
  const { t } = useLingui();
  const { data: settings } = useKanbanSettingsQuery();
  const mutation = useKanbanSettingsMutation();
  const [draft, setDraft] = useState(String(settings.configured ?? settings.effective));
  const [error, setError] = useState<string | null>(null);
  const value = validConcurrency(draft);
  const busy = mutation.isPending;
  const { effective } = settings;
  const deviceDefault = settings.configured === null ? t`(기기 기본값: CPU 코어 절반, 1~4개)` : "";

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const save = (concurrency: number | null) =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        const saved = yield* uiPromise(() => mutation.mutateAsync(concurrency)).pipe(
          Effect.catchTag("UnknownError", (failure) =>
            Effect.as(
              Effect.sync(() => setError(failureText(failure))),
              null,
            ),
          ),
        );
        if (saved !== null) setDraft(String(saved.configured ?? saved.effective));
      }),
    );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== null) void save(value);
      }}
    >
      <Field>
        <FieldLabel htmlFor="kanban-concurrency">
          <Trans>동시에 실행할 카드 수</Trans>
        </FieldLabel>
        <div className="flex gap-2">
          <Input
            id="kanban-concurrency"
            type="number"
            inputMode="numeric"
            min={1}
            max={maximumConcurrency}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="w-24"
          />
          {/* Unchanged is the number shown, which is the device default when none is saved. */}
          <Button
            type="submit"
            disabled={busy || value === null || value === (settings.configured ?? effective)}
          >
            {busy && <Spinner />} <Trans comment="Button that saves a settings field">저장</Trans>
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || settings.configured === null}
            onClick={() => void save(null)}
          >
            <Trans comment="Button that clears the saved card count so the device default applies">
              기본값으로
            </Trans>
          </Button>
        </div>
        <FieldDescription>
          <Trans comment="{effective} is the card count in use; {deviceDefault} is empty, or a parenthesized note when the count is the device default">
            모든 Goal의 카드를 합쳐 이만큼만 동시에 실행합니다. 지금 {effective}개{deviceDefault}로
            실행합니다. 저장하면 바로 적용됩니다. 실행 중인 카드는 멈추지 않습니다. 빈 슬롯은 아래
            프로젝트 순서, 그 안에서는 칸반 보드의 대화 순서대로 줍니다.
          </Trans>
        </FieldDescription>
      </Field>
      <PageError error={error} />
    </form>
  );
}

/** The projects in the order the scheduler serves them; a person moves one up or down. */
function ProjectOrderField() {
  const { t } = useLingui();
  const { data: settings } = useKanbanSettingsQuery();
  const projects = useProjectsQuery().data ?? [];
  const mutation = useProjectOrderMutation();
  const [error, setError] = useState<string | null>(null);
  const byId = HashMap.fromIterable(Iterable.map(projects, (project) => [project.id, project]));
  const ordered = settings.projectOrder.flatMap((id) => Option.toArray(HashMap.get(byId, id)));
  const move = (projectId: string, before: string | null) => {
    setError(null);
    mutation.mutate(
      { projectId, before },
      {
        onError: (failure) =>
          setError(isApiError(failure) ? errorText(failure.code) : changeFailed()),
      },
    );
  };

  return (
    <Field>
      <FieldLabel htmlFor="kanban-project-order">
        <Trans comment="Label of the list that orders projects for the kanban scheduler">
          프로젝트 순서
        </Trans>
      </FieldLabel>
      <ol
        id="kanban-project-order"
        aria-label={t({
          message: "프로젝트 순서",
          comment: "Label of the list that orders projects for the kanban scheduler",
        })}
        className="divide-y rounded-md border"
      >
        {ordered.map((project, index) => (
          <li key={project.id} className="flex items-center gap-1 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label={t({
                message: `${ph({ project: project.name })} 위로`,
                comment: "Button that moves {project} one place up in the kanban project order",
              })}
              disabled={mutation.isPending || index === 0}
              onClick={() => move(project.id, ordered[index - 1]?.id ?? null)}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label={t({
                message: `${ph({ project: project.name })} 아래로`,
                comment: "Button that moves {project} one place down in the kanban project order",
              })}
              disabled={mutation.isPending || index === ordered.length - 1}
              onClick={() => move(project.id, ordered[index + 2]?.id ?? null)}
            >
              <ChevronDownIcon />
            </Button>
          </li>
        ))}
      </ol>
      <FieldDescription>
        <Trans>
          위 프로젝트의 카드부터 실행합니다. 한 프로젝트 안에서는 칸반 보드의 대화 순서를 따릅니다.
        </Trans>
      </FieldDescription>
      <PageError error={error} />
    </Field>
  );
}

const roles = ["planner", "executor", "verifier"] as const satisfies readonly AgentRole[];

/** What each role of a Goal does. */
const roleTexts = {
  planner: {
    label: msg`Plan 작성자 모델`,
    description: msg`Goal을 붙잡고 다음 Plan을 쓰는 대화의 모델입니다. 칸반 보드로 실행 중인 대화에 쓰입니다.`,
  },
  executor: {
    label: msg`실행자 모델`,
    description: msg`카드 하나를 맡아 그 카드의 worktree에서 작업하는 카드 에이전트의 모델입니다.`,
  },
  verifier: {
    label: msg`검증자 모델`,
    description: msg`끝난 카드와 merge 전 Goal 브랜치를 고치지 않고 판정만 하는 모델입니다.`,
  },
} satisfies Record<
  AgentRole,
  { readonly label: MessageDescriptor; readonly description: MessageDescriptor }
>;

/** One role's own model, or the selected model when the user leaves it unset. */
function RoleModelField({ role }: { role: AgentRole }) {
  const { t } = useLingui();
  const { data: settings } = useKanbanSettingsQuery();
  const mutation = useRoleModelMutation();
  const [error, setError] = useState<string | null>(null);
  return (
    <ModelSelectionField
      id={`kanban-role-${role}`}
      label={t(roleTexts[role].label)}
      description={t(roleTexts[role].description)}
      saved={settings.roleModels[role]}
      unsetLabel={t({
        message: "선택된 모델",
        comment: "Option: run this role on the model selected in the chat",
      })}
      unsetNote={<Trans>지금은 선택된 모델로 실행합니다.</Trans>}
      busy={mutation.isPending}
      error={error}
      onSave={(selection) => {
        setError(null);
        mutation.mutate(
          { role, selection },
          {
            onError: (failure) =>
              setError(isApiError(failure) ? errorText(failure.code) : changeFailed()),
          },
        );
      }}
    />
  );
}

/** Branches this project's Goals never merge into on their own. */
function ProtectedBranchesField({ project }: { project: Project }) {
  const { data: settings } = useSuspenseProjectKanbanQuery(project.id);
  const mutation = useProtectedBranchesMutation(project.id);
  const [draft, setDraft] = useState(settings.protectedBranches.join(", "));
  const [error, setError] = useState<string | null>(null);
  const busy = mutation.isPending;
  const unchanged = branchList(draft).join(",") === settings.protectedBranches.join(",");

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const save = () =>
    runUiEffect(
      Effect.gen(function* () {
        setError(null);
        const saved = yield* uiPromise(() => mutation.mutateAsync(branchList(draft))).pipe(
          Effect.catchTag("UnknownError", (failure) =>
            Effect.as(
              Effect.sync(() => setError(failureText(failure))),
              null,
            ),
          ),
        );
        if (saved !== null) setDraft(saved.protectedBranches.join(", "));
      }),
    );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field>
        <FieldLabel htmlFor="kanban-protected-branches">
          <Trans comment="Field label; {project} is the project name">
            보호 브랜치 ({ph({ project: project.name })})
          </Trans>
        </FieldLabel>
        <div className="flex gap-2">
          <Input
            id="kanban-protected-branches"
            value={draft}
            placeholder="main, staging"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" disabled={busy || unchanged}>
            {busy && <Spinner />} <Trans comment="Button that saves a settings field">저장</Trans>
          </Button>
        </div>
        <FieldDescription>
          <Trans>
            Goal을 시작한 브랜치가 여기 있으면 카드가 모두 끝나도 자동으로 merge하지 않습니다. 대신
            PR을 만들지 직접 merge할지 묻습니다. 쉼표로 구분합니다. 비우면 모든 브랜치에 자동으로
            merge합니다.
          </Trans>
        </FieldDescription>
      </Field>
      <PageError error={error} />
    </form>
  );
}

/** Kanban execution: how many cards run at once, which project goes first, and where Goals merge. */
export function KanbanSettings({ project }: { project: Project | null }) {
  const { t } = useLingui();
  return (
    <FieldGroup>
      <PageHeader
        title={t(pageTitles.kanban)}
        description={
          <Trans>
            Goal을 칸반 보드로 실행할 때 쓰는 값을 정합니다. 함께 돌릴 카드 수, Plan
            작성·실행·검증에 쓸 모델, 끝난 Goal을 자동으로 merge할 브랜치입니다.
          </Trans>
        }
      />
      <ConcurrencyField />
      <ProjectOrderField />
      {roles.map((role) => (
        <RoleModelField key={role} role={role} />
      ))}
      {project === null ? (
        <p className="text-sm text-muted-foreground">
          <Trans>보호 브랜치는 프로젝트마다 정합니다. 프로젝트를 고른 뒤 다시 열어 주십시오.</Trans>
        </p>
      ) : (
        <ProtectedBranchesField project={project} />
      )}
    </FieldGroup>
  );
}
