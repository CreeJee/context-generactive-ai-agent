import { useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { PromptInputButton } from "~/components/ui/prompt-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import type { CatalogTarget, ModelSelection } from "../api";
import { effortChoices } from "../navigation/providers";
import { useCatalogQuery } from "../queries/global";
import { useSessionModelMutation } from "../queries/mutations/session";
import { sourceKey, sourceOf, useModelSources } from "../settings/model-selection-field";
import { runUiEffect, uiPromise } from "../shared/ui-effect";

/**
 * The conversation's model: its own, or the app's selected one until it has one. Choosing here
 * saves the model on this conversation only.
 */
export function SessionModelPicker({
  projectId,
  sessionId,
  holder,
  model,
  disabled,
}: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly holder: string;
  /** The model the conversation runs on now; null when the app has none selected either. */
  readonly model: ModelSelection | null;
  readonly disabled: boolean;
}) {
  const { t } = useLingui();
  const mutation = useSessionModelMutation(projectId, sessionId, holder);
  const { sources } = useModelSources();
  // The source the user is browsing; until one is picked it is the current model's own.
  const [browsed, setBrowsed] = useState<CatalogTarget | null>(null);
  const [failed, setFailed] = useState(false);
  const source = browsed ?? (model === null ? null : sourceOf(model));
  const currentCatalog = useCatalogQuery(model === null ? null : sourceOf(model));
  const catalog = useCatalogQuery(source);
  const models = catalog.data?.models ?? [];
  const current = currentCatalog.data?.models.find((candidate) => candidate.id === model?.model);
  const onSource =
    model !== null && source !== null && sourceKey(sourceOf(model)) === sourceKey(source);
  const shown = onSource ? models.find((candidate) => candidate.id === model.model) : undefined;
  const efforts = onSource && shown !== undefined ? effortChoices(model, shown) : [];
  const effortLabel =
    model === null || current === undefined
      ? undefined
      : effortChoices(model, current).find((choice) => choice.id === model.reasoningEffort)?.label;
  const busy = disabled || mutation.isPending;
  const sourceItems = sources.map((candidate) => ({
    value: sourceKey(candidate.source),
    label: candidate.label,
  }));
  const modelItems = models.map((candidate) => ({
    value: candidate.id,
    label: candidate.displayName,
  }));
  const effortItems = efforts.map((choice) => ({ value: choice.id, label: choice.label }));

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const save = (next: ModelSelection) =>
    runUiEffect(
      Effect.gen(function* () {
        setFailed(false);
        yield* uiPromise(() => mutation.mutateAsync(next)).pipe(
          Effect.catchTag("UnknownError", () => Effect.sync(() => setFailed(true))),
        );
      }),
    );

  return (
    <Popover>
      <PopoverTrigger
        render={
          <PromptInputButton
            variant="ghost"
            aria-label={t({
              message: "이 대화의 모델",
              comment: "Composer button that opens this conversation's model picker",
            })}
            title={t({
              message: "이 대화의 모델",
              comment: "Hover text of the composer button that opens the model picker",
            })}
          />
        }
      >
        <span className="max-w-48 truncate">
          {model === null
            ? t({
                message: "모델 고르기",
                comment: "Composer button text while the conversation has no model",
              })
            : effortLabel === undefined
              ? (current?.displayName ?? model.model)
              : `${current?.displayName ?? model.model} · ${effortLabel}`}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start">
        <Select
          value={source === null ? "" : sourceKey(source)}
          items={sourceItems}
          disabled={busy}
          onValueChange={(value) =>
            setBrowsed(
              sources.find((candidate) => sourceKey(candidate.source) === value)?.source ?? null,
            )
          }
        >
          <SelectTrigger
            aria-label={t({
              message: "모델 출처",
              comment:
                "Select in the model picker: which provider or endpoint the model comes from",
            })}
          >
            <SelectValue
              placeholder={t({
                message: "출처 고르기",
                comment: "Placeholder of the source select in the model picker",
              })}
            />
          </SelectTrigger>
          <SelectContent>
            {sourceItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {source !== null && (
          <Select
            value={onSource ? model.model : ""}
            items={modelItems}
            disabled={busy || models.length === 0}
            onValueChange={(value) => {
              const next = models.find((candidate) => candidate.id === value);
              if (next !== undefined)
                void save({
                  ...source,
                  model: next.id,
                  reasoningEffort: next.defaultReasoningEffort,
                });
            }}
          >
            <SelectTrigger
              aria-label={t({
                message: "모델",
                comment: "Select in the model picker: which model the conversation runs on",
              })}
            >
              <SelectValue
                placeholder={t({
                  message: "모델 고르기",
                  comment: "Placeholder of the model select before one is picked",
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {modelItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {onSource && efforts.length > 0 && (
          <Select
            value={model.reasoningEffort}
            items={effortItems}
            disabled={busy}
            onValueChange={(value) => {
              if (value !== null) void save({ ...model, reasoningEffort: value });
            }}
          >
            <SelectTrigger
              aria-label={t({
                message: "추론 단계",
                comment: "Select in the model picker: how much the model reasons",
              })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {effortItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {catalog.isError && (
          <p className="text-destructive">
            {t`모델 목록을 읽지 못했습니다. 그 제공자에 로그인했는지 확인해 주십시오.`}
          </p>
        )}
        {failed && (
          <p className="text-destructive">
            {t`모델을 바꾸지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주십시오.`}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
