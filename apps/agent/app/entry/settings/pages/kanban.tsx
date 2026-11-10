import { Array as Arr, type Cause, Effect, HashMap, Iterable, Option } from "effect";
import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import {
  isApiError,
  type AgentRole,
  type ApiErrorCode,
  type ModelSelection,
  type Project,
  type ProviderId,
} from "../../api";
import { effortChoices, providerLabels } from "../../navigation/providers";
import { useKanbanSettingsQuery, useModelsQuery, useProjectsQuery } from "../../queries/global";
import {
  useKanbanSettingsMutation,
  useProjectOrderMutation,
  useRoleModelMutation,
} from "../../queries/mutations/global";
import { useProtectedBranchesMutation } from "../../queries/mutations/project";
import { useSuspenseProjectKanbanQuery } from "../../queries/project";
import { PageHeader, PageError } from "../shared";
import { problemText } from "../../shared/copy-templates";
import { settingsCopy } from "../copy";

const copy = settingsCopy.kanban;
const { save: saveLabel, settingsChangeFailed } = settingsCopy.shared;

/** The most cards the user may let run at once (memory-agent `kanbanConcurrencyLimit`). */
const maximumConcurrency = 32;

const validConcurrency = (text: string) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= maximumConcurrency ? value : null;
};

/** Comma or whitespace separated branch names, without repeats. */
const branchList = (text: string) =>
  Arr.dedupe(text.split(/[\s,]+/u).filter((branch) => branch.length > 0));

const errorText = (code: ApiErrorCode) => {
  switch (code) {
    case "invalid_kanban_settings":
      return copy.errors.invalidSettings;
    case "project_not_found":
      return copy.errors.projectNotFound;
    case "role_model_unavailable":
      return problemText(copy.errors.roleModelUnavailable);
    case "settings_failed":
    case "schedule_storage_failed":
    case "storage_failed":
      return problemText(copy.errors.saveFailed);
    default:
      return settingsChangeFailed;
  }
};

/** The page's wording for a failed save, from the response's error code only. */
const failureText = (failure: Cause.UnknownError) =>
  isApiError(failure.cause) ? errorText(failure.cause.code) : settingsChangeFailed;

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
        <FieldLabel htmlFor="kanban-concurrency">{copy.concurrencyLabel}</FieldLabel>
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
          <Button type="submit" disabled={busy || value === null || value === settings.configured}>
            {busy && <Spinner />} {saveLabel}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || settings.configured === null}
            onClick={() => void save(null)}
          >
            {copy.useDefault}
          </Button>
        </div>
        <FieldDescription>
          {copy.concurrencyHelp(
            settings.effective,
            settings.configured === null ? copy.deviceDefault : "",
          )}
        </FieldDescription>
      </Field>
      <PageError error={error} />
    </form>
  );
}

/** The projects in the order the scheduler serves them; a person moves one up or down. */
function ProjectOrderField() {
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
          setError(isApiError(failure) ? errorText(failure.code) : settingsChangeFailed),
      },
    );
  };

  return (
    <Field>
      <FieldLabel htmlFor="kanban-project-order">{copy.projectOrder}</FieldLabel>
      <ol
        id="kanban-project-order"
        aria-label={copy.projectOrder}
        className="divide-y rounded-md border"
      >
        {ordered.map((project, index) => (
          <li key={project.id} className="flex items-center gap-1 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label={copy.moveUp(project.name)}
              disabled={mutation.isPending || index === 0}
              onClick={() => move(project.id, ordered[index - 1]?.id ?? null)}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label={copy.moveDown(project.name)}
              disabled={mutation.isPending || index === ordered.length - 1}
              onClick={() => move(project.id, ordered[index + 2]?.id ?? null)}
            >
              <ChevronDownIcon />
            </Button>
          </li>
        ))}
      </ol>
      <FieldDescription>{copy.projectOrderHelp}</FieldDescription>
      <PageError error={error} />
    </Field>
  );
}

const roles = ["planner", "executor", "verifier"] as const satisfies readonly AgentRole[];

const providerIds = [
  "openai",
  "anthropic",
  "openai-compatible",
] as const satisfies readonly ProviderId[];

/** The provider select's value for "run on the selected model". */
const followSelected = "selected";

const sameSelection = (left: ModelSelection | null, right: ModelSelection | null) =>
  left?.provider === right?.provider &&
  left?.model === right?.model &&
  left?.reasoningEffort === right?.reasoningEffort;

/** One role's own model, or the selected model when the user leaves it unset. */
function RoleModelField({ role }: { role: AgentRole }) {
  const { data: settings } = useKanbanSettingsQuery();
  const saved = settings.roleModels[role];
  const mutation = useRoleModelMutation();
  const [provider, setProvider] = useState<ProviderId | null>(saved?.provider ?? null);
  const [modelId, setModelId] = useState<string | null>(saved?.model ?? null);
  const [effort, setEffort] = useState<string | null>(saved?.reasoningEffort ?? null);
  const [error, setError] = useState<string | null>(null);
  const catalog = useModelsQuery(provider ?? "openai", provider !== null);
  const models = catalog.data?.models ?? [];
  const model = models.find((candidate) => candidate.id === modelId);
  const draft: ModelSelection | null =
    provider !== null &&
    model !== undefined &&
    effort !== null &&
    model.supportedReasoningEfforts.includes(effort)
      ? { provider, model: model.id, reasoningEffort: effort }
      : null;
  const efforts = draft === null || model === undefined ? [] : effortChoices(draft, model);
  const busy = mutation.isPending;
  const text = copy.roles[role];
  const id = `kanban-role-${role}`;

  const save = (selection: ModelSelection | null) => {
    setError(null);
    mutation.mutate(
      { role, selection },
      {
        onError: (failure) =>
          setError(isApiError(failure) ? errorText(failure.code) : settingsChangeFailed),
      },
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save(provider === null ? null : draft);
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>{text.label}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Select
            value={provider ?? followSelected}
            disabled={busy}
            onValueChange={(value) => {
              setProvider(providerIds.find((candidate) => candidate === value) ?? null);
              setModelId(null);
              setEffort(null);
            }}
          >
            <SelectTrigger id={id} className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={followSelected}>{copy.selectedModel}</SelectItem>
              {providerIds.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {providerLabels[candidate]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {provider !== null && (
            <Select
              value={modelId ?? ""}
              disabled={busy || models.length === 0}
              onValueChange={(value) => {
                const next = models.find((candidate) => candidate.id === value);
                setModelId(next?.id ?? null);
                setEffort(next?.defaultReasoningEffort ?? null);
              }}
            >
              <SelectTrigger aria-label={copy.modelSelect(text.label)} className="w-56">
                <SelectValue placeholder={copy.modelPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {models.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {efforts.length > 0 && (
            <Select
              value={effort ?? ""}
              disabled={busy}
              onValueChange={(value) => setEffort(value)}
            >
              <SelectTrigger aria-label={copy.effortSelect(text.label)} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {efforts.map((choice) => (
                  <SelectItem key={choice.id} value={choice.id}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            type="submit"
            disabled={
              busy ||
              (provider === null ? saved === null : draft === null || sameSelection(draft, saved))
            }
          >
            {busy && <Spinner />} {saveLabel}
          </Button>
        </div>
        <FieldDescription>
          {text.description}{" "}
          {saved === null
            ? copy.runsSelected
            : copy.runsOn(providerLabels[saved.provider], saved.model, saved.reasoningEffort)}{" "}
          {copy.appliesNextRun}
        </FieldDescription>
        {catalog.isError && <PageError error={problemText(copy.modelsFailed)} />}
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
        <FieldLabel htmlFor="kanban-protected-branches">
          {copy.protectedBranches(project.name)}
        </FieldLabel>
        <div className="flex gap-2">
          <Input
            id="kanban-protected-branches"
            value={draft}
            placeholder="main, staging"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" disabled={busy || unchanged}>
            {busy && <Spinner />} {saveLabel}
          </Button>
        </div>
        <FieldDescription>{copy.protectedBranchesHelp}</FieldDescription>
      </Field>
      <PageError error={error} />
    </form>
  );
}

/** Kanban execution: how many cards run at once, which project goes first, and where Goals merge. */
export function KanbanSettings({ project }: { project: Project | null }) {
  return (
    <FieldGroup>
      <PageHeader title={settingsCopy.titles.kanban} description={copy.description} />
      <ConcurrencyField />
      <ProjectOrderField />
      {roles.map((role) => (
        <RoleModelField key={role} role={role} />
      ))}
      {project === null ? (
        <p className="text-sm text-muted-foreground">{copy.protectedBranchesNoProject}</p>
      ) : (
        <ProtectedBranchesField project={project} />
      )}
    </FieldGroup>
  );
}
