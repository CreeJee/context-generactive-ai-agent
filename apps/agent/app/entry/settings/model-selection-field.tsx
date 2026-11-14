import { ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import type { CatalogTarget, ModelSelection, SubscriptionAccountProvider } from "../api";
import { effortChoices, providerLabels } from "../navigation/providers";
import { useCatalogQuery, useCompatibleAccountsQuery } from "../queries/global";
import { PageError } from "./shared";

const subscriptionProviders = [
  "openai",
  "anthropic",
] as const satisfies readonly SubscriptionAccountProvider[];

/** The source select's value for "no model of its own". */
const unset = "unset";

/** The source select's value: a subscription provider, or one compatible endpoint account. */
export const sourceKey = (source: CatalogTarget) =>
  source.provider === "openai-compatible"
    ? `${source.provider}:${source.account}`
    : source.provider;

/** Where a saved model comes from; a compatible one names its endpoint account. */
export const sourceOf = (selection: ModelSelection): CatalogTarget =>
  selection.provider === "openai-compatible"
    ? { provider: selection.provider, account: selection.account }
    : { provider: selection.provider };

/** Where a model can come from: each subscription provider and each compatible endpoint. */
export function useModelSources() {
  const { t } = useLingui();
  const compatible = useCompatibleAccountsQuery();
  // Each compatible endpoint is a source of its own, named by the user's label for it.
  const sources: ReadonlyArray<{ readonly source: CatalogTarget; readonly label: string }> = [
    ...subscriptionProviders.map((provider) => ({
      source: { provider },
      label: t(providerLabels[provider]),
    })),
    ...(compatible.data?.accounts ?? []).map((account) => ({
      source: { provider: "openai-compatible" as const, account: account.id },
      label: account.label,
    })),
  ];
  const sourceLabel = (target: CatalogTarget) =>
    sources.find((candidate) => sourceKey(candidate.source) === sourceKey(target))?.label ??
    t(providerLabels[target.provider]);
  return { sources, sourceLabel };
}

const sameSelection = (left: ModelSelection | null, right: ModelSelection | null) =>
  left !== null &&
  right !== null &&
  sourceKey(sourceOf(left)) === sourceKey(sourceOf(right)) &&
  left.model === right.model &&
  left.reasoningEffort === right.reasoningEffort;

/**
 * A model the user gives one part of the app: a subscription provider or one compatible endpoint,
 * one of its models and an effort, or none (`unsetLabel`). Saving hands the choice to `onSave`,
 * null for none.
 */
export function ModelSelectionField({
  id,
  label,
  description,
  saved,
  unsetLabel,
  unsetNote,
  busy,
  error,
  onSave,
}: {
  id: string;
  label: string;
  description: ReactNode;
  saved: ModelSelection | null;
  /** The source select's option for no model of its own. */
  unsetLabel: string;
  /** What happens while no model is saved. */
  unsetNote: ReactNode;
  busy: boolean;
  error: string | null;
  onSave: (selection: ModelSelection | null) => void;
}) {
  const { t } = useLingui();
  const [source, setSource] = useState<CatalogTarget | null>(
    saved === null ? null : sourceOf(saved),
  );
  const [modelId, setModelId] = useState<string | null>(saved?.model ?? null);
  const [effort, setEffort] = useState<string | null>(saved?.reasoningEffort ?? null);
  const { sources, sourceLabel } = useModelSources();
  const catalog = useCatalogQuery(source);
  const models = catalog.data?.models ?? [];
  const model = models.find((candidate) => candidate.id === modelId);
  const draft: ModelSelection | null =
    source !== null &&
    model !== undefined &&
    effort !== null &&
    model.supportedReasoningEfforts.includes(effort)
      ? { ...source, model: model.id, reasoningEffort: effort }
      : null;
  const efforts = draft === null || model === undefined ? [] : effortChoices(draft, model);
  // Each select's labels by value, so the closed select shows the label and not the raw value.
  const sourceItems = [
    { value: unset, label: unsetLabel },
    ...sources.map((candidate) => ({ value: sourceKey(candidate.source), label: candidate.label })),
  ];
  const modelItems = models.map((candidate) => ({
    value: candidate.id,
    label: candidate.displayName,
  }));
  const effortItems = efforts.map((choice) => ({ value: choice.id, label: choice.label }));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(source === null ? null : draft);
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Select
            value={source === null ? unset : sourceKey(source)}
            items={sourceItems}
            disabled={busy}
            onValueChange={(value) => {
              setSource(
                sources.find((candidate) => sourceKey(candidate.source) === value)?.source ?? null,
              );
              setModelId(null);
              setEffort(null);
            }}
          >
            <SelectTrigger id={id} className="w-36">
              <SelectValue />
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
              value={modelId ?? ""}
              items={modelItems}
              disabled={busy || models.length === 0}
              onValueChange={(value) => {
                const next = models.find((candidate) => candidate.id === value);
                setModelId(next?.id ?? null);
                setEffort(next?.defaultReasoningEffort ?? null);
              }}
            >
              <SelectTrigger
                aria-label={t({
                  message: `${label}: 모델`,
                  comment: "Model select of a settings field; {label} is the field's name",
                })}
                className="w-56"
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
          {efforts.length > 0 && (
            <Select
              value={effort ?? ""}
              items={effortItems}
              disabled={busy}
              onValueChange={(value) => setEffort(value)}
            >
              <SelectTrigger
                aria-label={t({
                  message: `${label}: 추론 단계`,
                  comment:
                    "Reasoning effort select of a settings field; {label} is the field's name",
                })}
                className="w-32"
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
          <Button
            type="submit"
            disabled={
              busy ||
              (source === null ? saved === null : draft === null || sameSelection(draft, saved))
            }
          >
            {busy && <Spinner />} <Trans comment="Button that saves a settings field">저장</Trans>
          </Button>
        </div>
        <FieldDescription>
          {description}{" "}
          {saved === null ? (
            unsetNote
          ) : (
            <Trans comment="Which provider (or compatible endpoint, by its label), model and reasoning effort a settings field runs on">
              지금은 {ph({ provider: sourceLabel(sourceOf(saved)) })} / {ph({ model: saved.model })}{" "}
              ({ph({ effort: saved.reasoningEffort })})로 실행합니다.
            </Trans>
          )}{" "}
          <Trans>저장하면 다음 실행부터 적용됩니다.</Trans>
        </FieldDescription>
        {catalog.isError && (
          <PageError
            error={t`모델 목록을 읽지 못했습니다. 그 제공자에 로그인했는지 확인해 주십시오.`}
          />
        )}
      </Field>
      <PageError error={error} />
    </form>
  );
}
