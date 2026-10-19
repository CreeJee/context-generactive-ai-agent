import { type Cause, Effect } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { isApiError, type ApiErrorCode, type Project } from "../../api";
import { useKanbanSettingsQuery } from "../../queries/global";
import { useKanbanSettingsMutation } from "../../queries/mutations/global";
import { useProtectedBranchesMutation } from "../../queries/mutations/project";
import { useSuspenseProjectKanbanQuery } from "../../queries/project";
import { PageHeader, PageError } from "../shared";

/** The most cards the user may let run at once (memory-agent `kanbanConcurrencyLimit`). */
const maximumConcurrency = 32;

const validConcurrency = (text: string) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= maximumConcurrency ? value : null;
};

/** Comma or whitespace separated branch names, without repeats. */
const branchList = (text: string) => [
  ...new Set(text.split(/[\s,]+/u).filter((branch) => branch.length > 0)),
];

const errorText = (code: ApiErrorCode) => {
  switch (code) {
    case "invalid_kanban_settings":
      return "값이 올바르지 않아요. 동시 실행 수는 1~32, 브랜치 이름은 영문·숫자·._/-만 쓸 수 있어요.";
    case "project_not_found":
      return "프로젝트를 찾을 수 없어요.";
    case "settings_failed":
    case "schedule_storage_failed":
    case "storage_failed":
      return "설정을 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.";
    default:
      return "설정을 바꾸지 못했어요.";
  }
};

/** The page's wording for a failed save, from the response's error code only. */
const failureText = (failure: Cause.UnknownError) =>
  isApiError(failure.cause) ? errorText(failure.cause.code) : "설정을 바꾸지 못했어요.";

/** How many kanban cards run at once on this machine, across every Goal. */
function ConcurrencyField() {
  const { data: settings } = useKanbanSettingsQuery();
  const mutation = useKanbanSettingsMutation();
  const [draft, setDraft] = useState(String(settings.configured ?? settings.effective));
  const [error, setError] = useState<string | null>(null);
  const value = validConcurrency(draft);
  const busy = mutation.isPending;

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
        <FieldLabel htmlFor="kanban-concurrency">동시에 실행할 카드 수</FieldLabel>
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
          <Button
            type="submit"
            variant="outline"
            disabled={busy || value === null || value === settings.configured}
          >
            {busy && <Spinner />} 저장
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy || settings.configured === null}
            onClick={() => void save(null)}
          >
            기본값으로
          </Button>
        </div>
        <FieldDescription>
          모든 Goal의 카드를 합쳐 이만큼만 동시에 실행해요. 지금 {settings.effective}개
          {settings.configured === null ? "(기기 기본값: CPU 코어 절반, 1~4개)" : ""}로 실행해요.
          저장하면 바로 적용되고, 실행 중인 카드는 멈추지 않아요. 슬롯은 Goal 우선순위에 따라
          돌아가며 나눠요.
        </FieldDescription>
      </Field>
      <PageError error={error} />
    </form>
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
        <FieldLabel htmlFor="kanban-protected-branches">보호 브랜치 ({project.name})</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="kanban-protected-branches"
            value={draft}
            placeholder="main, staging"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={busy || unchanged}>
            {busy && <Spinner />} 저장
          </Button>
        </div>
        <FieldDescription>
          Goal을 시작한 브랜치가 여기 있으면, 카드가 모두 끝나도 자동으로 merge하지 않고 PR을 만들지
          직접 merge할지 물어요. 쉼표로 구분하고, 비우면 모든 브랜치에 자동으로 merge해요.
        </FieldDescription>
      </Field>
      <PageError error={error} />
    </form>
  );
}

/** Kanban execution: how many cards run at once and where Goals merge on their own. */
export function KanbanSettings({ project }: { project: Project | null }) {
  return (
    <FieldGroup>
      <PageHeader
        title="칸반 실행"
        description="Goal을 칸반 보드로 실행할 때 카드를 몇 개까지 함께 돌리고, 끝난 Goal을 어느 브랜치에 자동으로 merge할지 정해요."
      />
      <ConcurrencyField />
      {project === null ? (
        <p className="text-sm text-muted-foreground">
          보호 브랜치는 프로젝트마다 정해요. 프로젝트를 고른 뒤 다시 열어 주세요.
        </p>
      ) : (
        <ProtectedBranchesField project={project} />
      )}
    </FieldGroup>
  );
}
