import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Data, Option, Schema } from "effect";
import { cn } from "cn";
import { CheckIcon, PencilIcon, PlugIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  standardReasoningEfforts,
  type CompatibleReasoningLevels,
  type ReasoningEffortsSource,
} from "memory-agent/compatible-config";
import type { ProviderId } from "../api";
import { useCompatibleAccountsQuery } from "../queries/global";
import { useCompatibleAccountMutation } from "../queries/mutations/global";
import { ProviderHeader } from "./account-profiles";
import {
  compatibleClient,
  CompatibleRequestFailed,
  CompatibleRequestFailedReason,
  type CompatibleAccountChange,
  type CompatibleAccountStatus,
  type CompatibleModelInput,
  type DiscoveredModel,
} from "./compatible-client";
import { providerLabels } from "./providers";
import { formatTokenCount, parseTokenCount } from "./token-count";

const rejectedStatuses = Schema.Literals([400, 404, 502]);
/** What a rejected endpoint request means, by the status codes the server answers with. */
const rejectedStatusText = {
  400: msg`주소, 키 또는 모델 한도를 확인해 주십시오.`,
  404: msg`엔드포인트나 모델을 찾지 못했습니다. 목록을 새로고침해 주십시오.`,
  502: msg`엔드포인트가 응답하지 않았습니다. 주소와 서버 상태를 확인해 주십시오.`,
} satisfies Record<typeof rejectedStatuses.Type, MessageDescriptor>;

/** Safe text for a failed endpoint request; upstream bodies are never shown. */
export const compatibleErrorMessage = (failure: Error) => {
  if (!Schema.is(CompatibleRequestFailed)(failure)) return t`호환 공급자 요청에 실패했습니다.`;
  return CompatibleRequestFailedReason.matchOrElse(
    failure.reason,
    {
      RequestRejected: () =>
        failure.operation === "connect" && failure.status === 400
          ? t`주소, 키 또는 모델 한도를 확인해 주십시오. 키가 있는 엔드포인트의 주소를 바꾸려면 새 키를 넣거나 키를 지워야 합니다.`
          : Schema.is(rejectedStatuses)(failure.status)
            ? i18n._(rejectedStatusText[failure.status])
            : failure.message,
    },
    () => failure.message,
  );
};

export type CompatibleHandlers = {
  readonly onChange: (change: CompatibleAccountChange) => Promise<void>;
  readonly onTest: (accountId: string, modelId: string) => Promise<void>;
  readonly onDiscover: (accountId: string) => Promise<readonly DiscoveredModel[]>;
};

const newModel = (id = "", imageInput = false): CompatibleModelInput => ({
  id,
  contextWindow: 32768,
  outputBudget: null,
  toolCalling: true,
  imageInput,
});

/** A model's reasoning efforts as saved: the user's own list and the one the server published. */
interface StoredReasoning {
  readonly user: Option.Option<CompatibleReasoningLevels>;
  readonly server: Option.Option<CompatibleReasoningLevels>;
}
const noStoredReasoning: StoredReasoning = { user: Option.none(), server: Option.none() };

/** The saved efforts of a registered model; the server's count only when they name some. */
const storedReasoningOf = (model: CompatibleAccountStatus["models"][number]): StoredReasoning => ({
  user: Option.fromUndefinedOr(model.userReasoning),
  server: Option.fromUndefinedOr(model.reasoning).pipe(
    Option.filter((published) => published.model === model.id && published.options.length > 0),
    Option.map(({ source: _source, model: _model, ...levels }) => levels),
  ),
});

/** What the form does to the model's own effort list: leaves it, writes one, or removes it. */
type ReasoningDraft = Data.TaggedEnum<{
  kept: {};
  written: { readonly levels: CompatibleReasoningLevels };
  removed: {};
}>;
const ReasoningDraft = Data.taggedEnum<ReasoningDraft>();

/** The efforts the form shows, and where they come from (decisions.md 2026-11-18). */
const shownReasoning = (
  draft: ReasoningDraft,
  stored: StoredReasoning,
): { readonly levels: CompatibleReasoningLevels; readonly source: ReasoningEffortsSource } => {
  const published = Option.match(stored.server, {
    onNone: () => ({ levels: { options: standardReasoningEfforts }, source: "standard" as const }),
    onSome: (levels) => ({ levels, source: "server" as const }),
  });
  return ReasoningDraft.$match(draft, {
    kept: () =>
      Option.match(stored.user, {
        onNone: () => published,
        onSome: (levels) => ({ levels, source: "user" as const }),
      }),
    written: ({ levels }) => ({ levels, source: "user" as const }),
    removed: () => published,
  });
};

/** The `userReasoning` a save sends: none keeps the list, null removes it. */
const savedReasoning = (draft: ReasoningDraft) =>
  ReasoningDraft.$match(draft, {
    kept: () => ({}),
    written: ({ levels }) => ({ userReasoning: levels }),
    removed: () => ({ userReasoning: null }),
  });

/** How many efforts a list may hold, as the server checks it. */
const maxReasoningEfforts = 16;

/** The limit a turned-on output limit starts from. */
const initialOutputBudget = 4096;

/** The context windows a model can be registered with, as the server checks them. */
const contextWindowRange = { min: 1024, max: 10_000_000 } as const;
/** Context windows offered as one-click choices. */
const contextWindowPresets = [8192, 32_768, 131_072, 262_144, 1_048_576] as const;

/**
 * The model's reasoning efforts: the `reasoning_effort` values the picker offers, as written, and
 * the one a new conversation starts on.
 */
function ReasoningFields({
  idPrefix,
  shown,
  onWrite,
  onRemove,
}: {
  idPrefix: string;
  shown: ReturnType<typeof shownReasoning>;
  onWrite: (levels: CompatibleReasoningLevels) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const [adding, setAdding] = useState("");
  const { options, default: chosen } = shown.levels;
  const added = adding.trim();
  const canAdd =
    added !== "" &&
    added !== "default" &&
    !options.includes(added) &&
    options.length < maxReasoningEfforts;
  const add = () => {
    if (!canAdd) return;
    onWrite({ ...shown.levels, options: [...options, added] });
    setAdding("");
  };
  const drop = (effort: string) =>
    onWrite({
      options: options.filter((option) => option !== effort),
      default: chosen === effort ? undefined : chosen,
    });
  const serverDefault = "default";
  const startItems = [
    {
      value: serverDefault,
      label: t({
        message: "서버 기본값",
        comment: "Reasoning effort option: whatever the endpoint server uses by default",
      }),
    },
    ...options.map((effort) => ({ value: effort, label: effort })),
  ];
  return (
    <Field>
      <FieldLabel htmlFor={`${idPrefix}-effort`}>
        <Trans comment="Field label: the reasoning effort values the model's picker offers">
          추론 단계
        </Trans>
      </FieldLabel>
      <div
        role="group"
        className="flex flex-wrap gap-1"
        aria-label={t({
          message: "추론 단계 목록",
          comment: "Label of the reasoning efforts the model's picker offers",
        })}
      >
        {options.map((effort) => (
          <Badge key={effort} variant="secondary">
            {effort}
            <button
              type="button"
              className="rounded-full hover:text-foreground"
              aria-label={t({
                message: `${effort} 빼기`,
                comment:
                  "Button that removes a reasoning effort from the list; effort is its value",
              })}
              onClick={() => drop(effort)}
            >
              <XIcon className="size-2.5" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1">
        <Input
          id={`${idPrefix}-effort`}
          autoComplete="off"
          spellCheck={false}
          placeholder="xhigh"
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <Button type="button" variant="outline" disabled={!canAdd} onClick={add}>
          <PlusIcon />{" "}
          <Trans comment="Button that adds the typed reasoning effort to the list">추가</Trans>
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <FieldLabel htmlFor={`${idPrefix}-effort-start`} className="shrink-0">
          <Trans comment="Field label: the reasoning effort a new conversation starts on">
            시작 단계
          </Trans>
        </FieldLabel>
        <Select
          value={chosen ?? serverDefault}
          items={startItems}
          onValueChange={(value) =>
            onWrite({
              options,
              default: value === null || value === serverDefault ? undefined : value,
            })
          }
        >
          <SelectTrigger id={`${idPrefix}-effort-start`} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {startItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <FieldDescription>
        {i18n._(reasoningSourceNote[shown.source])}
        {shown.source === "user" && (
          <Button type="button" variant="link" size="xs" onClick={onRemove}>
            <Trans comment="Button that drops the user's effort list for the server's or the standard one">
              서버 값으로 되돌리기
            </Trans>
          </Button>
        )}
      </FieldDescription>
    </Field>
  );
}

/** What the effort editor says about where the list it shows comes from. */
const reasoningSourceNote = {
  user: msg`직접 적은 목록입니다. 값은 요청의 reasoning_effort로 그대로 보냅니다.`,
  server: msg`서버 모델 목록의 값입니다. 고치면 직접 적은 목록으로 저장합니다.`,
  standard: msg`서버가 추론 단계를 알려 주지 않아 표준 단계를 채웠습니다. 서버가 이 값을 받는지는 알 수 없습니다.`,
} satisfies Record<ReasoningEffortsSource, MessageDescriptor>;

function ConnectionFields({
  baseUrl,
  apiKey,
  hasApiKey,
  removeKey,
  onBaseUrl,
  onApiKey,
  onRemoveKey,
}: {
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  removeKey: boolean;
  onBaseUrl: (value: string) => void;
  onApiKey: (value: string) => void;
  onRemoveKey: (value: boolean) => void;
}) {
  const { t } = useLingui();
  const idPrefix = useId();
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-url`}>Base URL</FieldLabel>
        <Input
          id={`${idPrefix}-url`}
          type="url"
          required
          value={baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(event) => onBaseUrl(event.target.value)}
        />
        <FieldDescription>
          <Trans>/chat/completions 경로는 자동으로 붙습니다.</Trans>
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-key`}>
          <Trans comment="Field label: the endpoint's API key, which may be left empty">
            API 키 (선택)
          </Trans>
        </FieldLabel>
        <Input
          id={`${idPrefix}-key`}
          type="password"
          autoComplete="off"
          value={apiKey}
          disabled={removeKey}
          placeholder={
            hasApiKey
              ? t({
                  message: "등록된 키 유지",
                  comment: "Placeholder of the API key field: empty keeps the saved key",
                })
              : t`키 없는 로컬 서버도 연결할 수 있습니다`
          }
          onChange={(event) => onApiKey(event.target.value)}
        />
        <FieldDescription>
          <Trans>키는 OS 키체인에만 저장되고 다시 표시되지 않습니다.</Trans>
        </FieldDescription>
        {hasApiKey && (
          <div className="flex items-center gap-2">
            <Switch
              id={`${idPrefix}-remove-key`}
              checked={removeKey}
              onCheckedChange={onRemoveKey}
            />
            <FieldLabel htmlFor={`${idPrefix}-remove-key`}>
              <Trans>저장할 때 기존 키 삭제</Trans>
            </FieldLabel>
          </div>
        )}
      </Field>
    </>
  );
}

/** `apiKey` for a connection change: absent keeps the stored key, null removes it. */
const keyChange = (apiKey: string, removeKey: boolean) =>
  removeKey ? { apiKey: null } : apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() };

function AddEndpointForm({
  busy,
  onCreate,
  onClose,
}: {
  busy: boolean;
  onCreate: (change: CompatibleAccountChange) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  return (
    <form
      aria-label={t`새 OpenAI 호환 엔드포인트`}
      className="flex flex-col gap-3 rounded-lg border px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void onCreate({
          intent: "create",
          baseUrl: baseUrl.trim(),
          ...(label.trim() !== "" && { label: label.trim() }),
          ...keyChange(apiKey, false),
        })
          .then(onClose, (failure: Error) => setError(compatibleErrorMessage(failure)))
          .finally(() => setPending(false));
      }}
    >
      <Field>
        <FieldLabel htmlFor={labelId}>
          <Trans comment="Field label: the endpoint's name, which may be left empty">
            이름 (선택)
          </Trans>
        </FieldLabel>
        <Input
          id={labelId}
          value={label}
          maxLength={80}
          placeholder={t`비워 두면 서버 주소로 부릅니다`}
          onChange={(event) => setLabel(event.target.value)}
          autoFocus
        />
      </Field>
      <ConnectionFields
        baseUrl={baseUrl}
        apiKey={apiKey}
        hasApiKey={false}
        removeKey={false}
        onBaseUrl={setBaseUrl}
        onApiKey={setApiKey}
        onRemoveKey={() => {}}
      />
      <div className="flex justify-end gap-1">
        <Button type="button" variant="outline" onClick={onClose}>
          <Trans comment="Button that closes the new endpoint form">취소</Trans>
        </Button>
        <Button type="submit" disabled={busy || pending || baseUrl.trim() === ""}>
          {pending && <Spinner />} <Trans comment="Button that adds the endpoint">추가</Trans>
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}

function ModelForm({
  initial,
  reasoning,
  busy,
  onDiscover,
  onSave,
  onClose,
}: {
  initial: CompatibleModelInput;
  /** The edited model's saved efforts; none for a new model. */
  reasoning: StoredReasoning;
  busy: boolean;
  onDiscover: () => Promise<readonly DiscoveredModel[]>;
  onSave: (model: CompatibleModelInput) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [model, setModel] = useState(initial);
  const [contextText, setContextText] = useState(() => formatTokenCount(initial.contextWindow));
  /** Whether the context window shown is the one the server's model list published. */
  const [contextListed, setContextListed] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly DiscoveredModel[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<string | null>(null);
  /** The efforts the server publishes for the model, updated when a listed model is picked. */
  const [stored, setStored] = useState(reasoning);
  const [reasoningDraft, setReasoningDraft] = useState<ReasoningDraft>(ReasoningDraft.kept());
  const idPrefix = useId();
  const discover = () => {
    setDiscovering(true);
    setDiscovery(null);
    void onDiscover()
      .then(
        (models) => {
          setSuggestions(models);
          setDiscovery(
            t({
              message: `${ph({ count: models.length })}개 모델을 불러왔습니다. 목록에 없는 ID도 직접 입력할 수 있습니다.`,
              comment: "count is how many models the server listed",
            }),
          );
        },
        (failure: Error) => setDiscovery(compatibleErrorMessage(failure)),
      )
      .finally(() => setDiscovering(false));
  };
  const parsedContext = parseTokenCount(contextText).pipe(
    Option.filter((count) => count >= contextWindowRange.min && count <= contextWindowRange.max),
  );
  /** The window the form saves; the field's text is the source until it is saved. */
  const contextWindow = Option.getOrElse(parsedContext, () => model.contextWindow);
  const setContextWindow = (count: number, listed: boolean) => {
    setContextText(formatTokenCount(count));
    setContextListed(listed);
  };
  /** Picks a listed model, with the context window the list published for it when it did. */
  const pick = ({ id, contextWindow, reasoning: published }: DiscoveredModel) => {
    setModel((current) => ({ ...current, id }));
    setStored((current) => ({ ...current, server: Option.fromUndefinedOr(published) }));
    Option.match(Option.fromUndefinedOr(contextWindow), {
      onNone: () => undefined,
      onSome: (listed) => setContextWindow(listed, true),
    });
  };
  return (
    <form
      aria-label={t({ message: "모델 등록", comment: "Label of the form that registers a model" })}
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        Option.match(parsedContext, {
          onNone: () => undefined,
          onSome: (count) =>
            onSave({
              ...model,
              id: model.id.trim(),
              contextWindow: count,
              ...savedReasoning(reasoningDraft),
            }),
        });
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-id`}>
          <Trans comment="Field label: the model id the server expects">모델 ID</Trans>
        </FieldLabel>
        <div className="flex gap-1">
          <Input
            id={`${idPrefix}-id`}
            required
            value={model.id}
            onChange={(event) => setModel({ ...model, id: event.target.value })}
          />
          <Button type="button" variant="outline" disabled={busy || discovering} onClick={discover}>
            {discovering && <Spinner />} <Trans>모델 목록 불러오기</Trans>
          </Button>
        </div>
        {suggestions.length > 0 && (
          <div
            className="flex flex-wrap gap-1.5"
            aria-label={t({
              message: "서버의 모델",
              comment: "Label of the models the server listed, offered as choices",
            })}
          >
            {suggestions.slice(0, 20).map((suggestion) => (
              <Button
                key={suggestion.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => pick(suggestion)}
              >
                {suggestion.id}
              </Button>
            ))}
          </div>
        )}
        {discovery !== null && (
          <p role="status" className="text-2xs text-muted-foreground">
            {discovery}
          </p>
        )}
        <FieldDescription>
          <Trans>서버에서 쓰는 정확한 ID를 입력해 주십시오.</Trans>
        </FieldDescription>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-context`}>
            <Trans>컨텍스트 창 (토큰)</Trans>
          </FieldLabel>
          <Input
            id={`${idPrefix}-context`}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="128K"
            aria-invalid={Option.isNone(parsedContext)}
            aria-describedby={`${idPrefix}-context-value`}
            value={contextText}
            onChange={(event) => {
              setContextText(event.target.value);
              setContextListed(false);
            }}
            onBlur={() =>
              Option.match(parsedContext, {
                onNone: () => undefined,
                onSome: (count) => setContextText(formatTokenCount(count)),
              })
            }
          />
          <div
            className="flex flex-wrap gap-1"
            aria-label={t({
              message: "자주 쓰는 컨텍스트 창",
              comment: "Label of the one-click context window choices such as 32K or 128K",
            })}
          >
            {contextWindowPresets.map((preset) => (
              <Button
                key={preset}
                type="button"
                variant={Option.contains(parsedContext, preset) ? "secondary" : "outline"}
                size="xs"
                onClick={() => setContextWindow(preset, false)}
              >
                {formatTokenCount(preset)}
              </Button>
            ))}
          </div>
          <FieldDescription id={`${idPrefix}-context-value`}>
            {Option.match(parsedContext, {
              onNone: () => (
                <Trans comment="Shown when the context window field holds no usable count">
                  1,024에서 10,000,000 사이의 토큰 수를 입력해 주십시오. 예: 128K, 131072
                </Trans>
              ),
              onSome: (count) => {
                const exact = count.toLocaleString("ko-KR");
                return contextListed ? (
                  <Trans comment="exact is the context window in tokens, from the server's model list">
                    {exact} 토큰 · 서버 모델 목록의 값
                  </Trans>
                ) : (
                  <Trans comment="exact is the context window in tokens">{exact} 토큰</Trans>
                );
              },
            })}
          </FieldDescription>
        </Field>
        <Field>
          <div className="flex items-center gap-2">
            <Switch
              id={`${idPrefix}-output-limit`}
              checked={model.outputBudget !== null}
              onCheckedChange={(limited) =>
                setModel({ ...model, outputBudget: limited ? initialOutputBudget : null })
              }
            />
            <FieldLabel htmlFor={`${idPrefix}-output-limit`}>
              <Trans>최대 출력 토큰 제한</Trans>
            </FieldLabel>
          </div>
          {model.outputBudget === null ? (
            <FieldDescription>
              <Trans>
                제한 없음: 서버의 한도까지 출력합니다. 추론 모델은 추론도 이 한도를 씁니다.
              </Trans>
            </FieldDescription>
          ) : (
            <Input
              id={`${idPrefix}-output`}
              aria-label={t`최대 출력 토큰`}
              type="number"
              required
              min={1}
              max={contextWindow - 1}
              step={1}
              value={model.outputBudget}
              onChange={(event) => setModel({ ...model, outputBudget: Number(event.target.value) })}
            />
          )}
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={`${idPrefix}-tools`}
          checked={model.toolCalling}
          onCheckedChange={(toolCalling) => setModel({ ...model, toolCalling })}
        />
        <FieldLabel htmlFor={`${idPrefix}-tools`}>
          <Trans>도구 호출 지원</Trans>
        </FieldLabel>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch
            id={`${idPrefix}-image-input`}
            checked={model.imageInput}
            onCheckedChange={(imageInput) => setModel({ ...model, imageInput })}
          />
          <FieldLabel htmlFor={`${idPrefix}-image-input`}>
            <Trans>이미지 입력 지원</Trans>
          </FieldLabel>
        </div>
        <FieldDescription>
          <Trans>
            끄면 이미지를 보낼 수 없습니다. 이미지가 있던 대화는 글 메모로 이어 보냅니다.
          </Trans>
        </FieldDescription>
      </div>
      <ReasoningFields
        idPrefix={idPrefix}
        shown={shownReasoning(reasoningDraft, stored)}
        onWrite={(levels) => setReasoningDraft(ReasoningDraft.written({ levels }))}
        onRemove={() => setReasoningDraft(ReasoningDraft.removed())}
      />
      <div className="flex justify-end gap-1">
        <Button type="button" variant="outline" onClick={onClose}>
          <Trans comment="Button that closes the model form">취소</Trans>
        </Button>
        <Button
          type="submit"
          disabled={busy || model.id.trim() === "" || Option.isNone(parsedContext)}
        >
          <Trans>모델 저장</Trans>
        </Button>
      </div>
    </form>
  );
}

type CardMode = Data.TaggedEnum<{
  view: {};
  rename: {};
  connect: {};
  model: { readonly initial: CompatibleModelInput; readonly reasoning: StoredReasoning };
}>;
const CardMode = Data.taggedEnum<CardMode>();

function EndpointCard({
  account,
  current,
  busy,
  handlers,
}: {
  account: CompatibleAccountStatus;
  current: boolean;
  busy: boolean;
  handlers: CompatibleHandlers;
}) {
  const { t } = useLingui();
  const [mode, setMode] = useState<CardMode>(CardMode.view());
  const [label, setLabel] = useState(account.label);
  const [baseUrl, setBaseUrl] = useState(account.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (task: () => Promise<void>, done?: string) => {
    setMessage(null);
    setError(null);
    return task().then(
      () => {
        if (done !== undefined) setMessage(done);
        setMode(CardMode.view());
      },
      (failure: Error) => setError(compatibleErrorMessage(failure)),
    );
  };
  const change = (next: CompatibleAccountChange, done?: string) =>
    run(() => handlers.onChange(next), done);
  const accountName = account.label;
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-lg border px-3 py-2.5",
        current && "border-primary/50",
      )}
      aria-label={t({
        message: `${accountName} (OpenAI 호환)`,
        comment: "Label of an endpoint's row; accountName is the endpoint's name",
      })}
    >
      {CardMode.$is("rename")(mode) ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim() === "") return;
            void change({ intent: "rename", accountId: account.id, label: label.trim() });
          }}
        >
          <Input
            aria-label={t({
              message: "계정 이름",
              comment: "Field for renaming an account in place",
            })}
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setMode(CardMode.view())}
            autoFocus
          />
          <Button
            type="submit"
            variant="ghost-muted"
            size="icon"
            aria-label={t({
              message: "이름 저장",
              comment: "Icon button that saves the account's new name",
            })}
          >
            <CheckIcon />
          </Button>
          <Button
            type="button"
            variant="ghost-muted"
            size="icon"
            aria-label={t({
              message: "이름 변경 취소",
              comment: "Icon button that drops the typed account name",
            })}
            onClick={() => {
              setLabel(account.label);
              setMode(CardMode.view());
            }}
          >
            <XIcon />
          </Button>
        </form>
      ) : (
        <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-0.5">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{account.label}</span>
            {current && (
              <Badge variant="outline">
                <Trans comment="Badge on the account chats run on now">사용 중</Trans>
              </Badge>
            )}
          </span>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={t`${accountName} 이름 변경`}
            onClick={() => setMode(CardMode.rename())}
          >
            <PencilIcon /> <Trans comment="Button that renames the account">이름 변경</Trans>
          </Button>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={t`${accountName} 연결 수정`}
            onClick={() => setMode(CardMode.connect())}
          >
            <PlugIcon />{" "}
            <Trans comment="Button that opens the endpoint's connection settings">연결</Trans>
          </Button>
          <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="sm"
                  aria-label={t`${accountName} 삭제`}
                  disabled={busy}
                />
              }
            >
              <Trash2Icon /> <Trans comment="Button that removes the endpoint">삭제</Trans>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>{accountName} 엔드포인트를 지울까요?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>저장한 API 키도 함께 지웁니다.</Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans comment="Dialog button that cancels">취소</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    setConfirmingRemove(false);
                    void change({ intent: "remove", accountId: account.id });
                  }}
                >
                  <Trans comment="Dialog button that confirms removing the endpoint">삭제</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {/* Below the buttons, the address gets the card's whole width. */}
          <span className="w-full truncate text-2xs text-muted-foreground" title={account.baseUrl}>
            {account.baseUrl} ·{" "}
            {account.hasApiKey ? (
              <Trans comment="Endpoint status: an API key is saved">키 있음</Trans>
            ) : (
              <Trans comment="Endpoint status: no API key is saved">키 없음</Trans>
            )}
          </span>
        </div>
      )}
      {CardMode.$is("connect")(mode) && (
        <form
          aria-label={t({
            message: `${accountName} 연결`,
            comment: "Label of the endpoint's connection form",
          })}
          className="flex flex-col gap-3 rounded-md border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void change(
              {
                intent: "connect",
                accountId: account.id,
                baseUrl: baseUrl.trim(),
                ...keyChange(apiKey, removeKey),
              },
              t`연결을 저장했습니다.`,
            ).then(() => {
              setApiKey("");
              setRemoveKey(false);
            });
          }}
        >
          <ConnectionFields
            baseUrl={baseUrl}
            apiKey={apiKey}
            hasApiKey={account.hasApiKey}
            removeKey={removeKey}
            onBaseUrl={setBaseUrl}
            onApiKey={setApiKey}
            onRemoveKey={setRemoveKey}
          />
          <div className="flex justify-end gap-1">
            <Button type="button" variant="outline" onClick={() => setMode(CardMode.view())}>
              <Trans comment="Button that closes the connection form">취소</Trans>
            </Button>
            <Button type="submit" disabled={busy}>
              <Trans>연결 저장</Trans>
            </Button>
          </div>
        </form>
      )}
      <ul
        className="flex flex-col gap-1"
        aria-label={t({
          message: `${accountName} 모델`,
          comment: "Label of the list of models registered under the endpoint",
        })}
      >
        {account.models.map((model) => {
          const modelId = model.id;
          const contextWindow = formatTokenCount(model.contextWindow);
          const output =
            model.outputBudget === null
              ? t({ message: "제한 없음", comment: "Model output limit: none set" })
              : formatTokenCount(model.outputBudget);
          const tools = model.toolCalling
            ? t({ message: "켬", comment: "Model tool calling: on" })
            : t({ message: "끔", comment: "Model tool calling: off" });
          return (
            <li key={model.id} className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{model.id}</span>
                <span className="text-muted-foreground">
                  {" "}
                  ·{" "}
                  <Trans comment="Model specs: context window tokens / max output tokens · tool calling">
                    {contextWindow} / 출력 {output} · 도구 {tools}
                  </Trans>
                  {model.imageInput === true &&
                    ` · ${t({ message: "이미지", comment: "Model spec: accepts image input" })}`}
                </span>
              </span>
              <Button
                variant="ghost-muted"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => handlers.onTest(account.id, model.id),
                    t`${modelId} 연결을 확인했습니다.`,
                  )
                }
              >
                <Trans comment="Button that sends a test request to the model">테스트</Trans>
              </Button>
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={t`${modelId} 수정`}
                onClick={() => {
                  const {
                    reasoning: _reasoning,
                    userReasoning: _userReasoning,
                    imageInputSource: _source,
                    ...input
                  } = model;
                  setMode(
                    CardMode.model({
                      initial: { ...input, imageInput: input.imageInput === true },
                      reasoning: storedReasoningOf(model),
                    }),
                  );
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={t`${modelId} 삭제`}
                disabled={busy}
                onClick={() =>
                  void change({ intent: "remove-model", accountId: account.id, modelId: model.id })
                }
              >
                <XIcon />
              </Button>
            </li>
          );
        })}
        {account.models.length === 0 && (
          <li className="text-xs text-muted-foreground">
            <Trans>
              등록한 모델이 없습니다. 모델을 추가해야 이 엔드포인트로 대화할 수 있습니다.
            </Trans>
          </li>
        )}
      </ul>
      {CardMode.$is("model")(mode) ? (
        <ModelForm
          key={mode.initial.id}
          initial={mode.initial}
          reasoning={mode.reasoning}
          busy={busy}
          onDiscover={() => handlers.onDiscover(account.id)}
          onSave={(model) =>
            void change(
              { intent: "save-model", accountId: account.id, model },
              t`모델을 저장했습니다.`,
            )
          }
          onClose={() => setMode(CardMode.view())}
        />
      ) : (
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setMode(CardMode.model({ initial: newModel(), reasoning: noStoredReasoning }))
            }
          >
            <PlusIcon /> <Trans>모델 추가</Trans>
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="text-2xs text-muted-foreground">
          {message}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}

/** Compatible endpoints as accounts: each has a connection and a catalog of registered models. */
export function CompatibleAccountsList({
  accounts,
  activeProvider,
  busy,
  failed,
  handlers,
}: {
  accounts: readonly CompatibleAccountStatus[] | undefined;
  activeProvider: ProviderId;
  busy: boolean;
  failed: boolean;
  handlers: CompatibleHandlers;
}) {
  const { t } = useLingui();
  const [adding, setAdding] = useState(false);
  return (
    <section
      aria-label={t(providerLabels["openai-compatible"])}
      className="flex flex-col gap-3 py-5"
    >
      <ProviderHeader
        provider="openai-compatible"
        description={t`Chat Completions 호환 서버를 엔드포인트마다 등록하고 쓸 모델을 직접 추가합니다. 공급자의 API 요금이 적용될 수 있습니다.`}
      >
        <Button
          variant="outline"
          size="sm"
          aria-label={t`OpenAI 호환 엔드포인트 추가`}
          disabled={adding || busy}
          onClick={() => setAdding(true)}
        >
          <PlusIcon /> <Trans>엔드포인트 추가</Trans>
        </Button>
      </ProviderHeader>
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>
            <Trans>엔드포인트 목록을 불러오지 못했습니다.</Trans>
          </AlertDescription>
        </Alert>
      )}
      {accounts === undefined ? (
        !failed && <Spinner />
      ) : accounts.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={t`OpenAI 호환 엔드포인트 목록`}>
          {accounts.map((account) => (
            <EndpointCard
              key={account.id}
              account={account}
              current={activeProvider === "openai-compatible" && account.selected}
              busy={busy}
              handlers={handlers}
            />
          ))}
        </ul>
      ) : (
        !adding && (
          <p className="text-xs text-muted-foreground">
            <Trans>추가한 엔드포인트가 없습니다.</Trans>
          </p>
        )
      )}
      {adding && (
        <AddEndpointForm
          busy={busy}
          onCreate={handlers.onChange}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

/** Loads and changes compatible endpoints for the account manager. */
export function CompatibleAccounts({ activeProvider }: { activeProvider: ProviderId }) {
  const accounts = useCompatibleAccountsQuery();
  const mutation = useCompatibleAccountMutation();
  return (
    <CompatibleAccountsList
      accounts={accounts.data?.accounts}
      activeProvider={activeProvider}
      busy={mutation.isPending}
      failed={accounts.isError}
      handlers={{
        onChange: (change) => mutation.mutateAsync(change).then(() => undefined),
        onTest: (accountId, modelId) =>
          compatibleClient.test(accountId, modelId).then(() => undefined),
        onDiscover: (accountId) =>
          compatibleClient.discover(accountId).then(({ models }) => models),
      }}
    />
  );
}
