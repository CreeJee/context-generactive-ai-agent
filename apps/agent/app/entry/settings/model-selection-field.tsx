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
import type { ModelSelection, ProviderId } from "../api";
import { effortChoices, providerLabels } from "../navigation/providers";
import { useModelsQuery } from "../queries/global";
import { PageError } from "./shared";

const providerIds = [
  "openai",
  "anthropic",
  "openai-compatible",
] as const satisfies readonly ProviderId[];

/** The provider select's value for "no model of its own". */
const unset = "unset";

const sameSelection = (left: ModelSelection | null, right: ModelSelection | null) =>
  left?.provider === right?.provider &&
  left?.model === right?.model &&
  left?.reasoningEffort === right?.reasoningEffort;

/**
 * A model the user gives one part of the app: a provider, one of its models and an effort, or
 * none (`unsetLabel`). Saving hands the choice to `onSave`, null for none.
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
  /** The provider select's option for no model of its own. */
  unsetLabel: string;
  /** What happens while no model is saved. */
  unsetNote: ReactNode;
  busy: boolean;
  error: string | null;
  onSave: (selection: ModelSelection | null) => void;
}) {
  const { t } = useLingui();
  const [provider, setProvider] = useState<ProviderId | null>(saved?.provider ?? null);
  const [modelId, setModelId] = useState<string | null>(saved?.model ?? null);
  const [effort, setEffort] = useState<string | null>(saved?.reasoningEffort ?? null);
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
  // Each select's labels by value, so the closed select shows the label and not the raw value.
  const providerItems = [
    { value: unset, label: unsetLabel },
    ...providerIds.map((candidate) => ({ value: candidate, label: t(providerLabels[candidate]) })),
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
        onSave(provider === null ? null : draft);
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Select
            value={provider ?? unset}
            items={providerItems}
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
              {providerItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {provider !== null && (
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
              (provider === null ? saved === null : draft === null || sameSelection(draft, saved))
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
            <Trans comment="Which provider, model and reasoning effort a settings field runs on">
              지금은 {ph({ provider: t(providerLabels[saved.provider]) })} /{" "}
              {ph({ model: saved.model })} ({ph({ effort: saved.reasoningEffort })})로 실행합니다.
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
