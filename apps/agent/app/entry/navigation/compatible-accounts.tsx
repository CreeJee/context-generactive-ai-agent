import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Data, Schema } from "effect";
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
import { Switch } from "~/components/ui/switch";
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
} from "./compatible-client";
import { providerLabels } from "./providers";

const rejectedStatuses = Schema.Literals([400, 404, 502]);
/** What a rejected endpoint request means, by the status codes the server answers with. */
const rejectedStatusText = {
  400: msg`주소, 키 또는 모델 한도를 확인해 주십시오. 키가 있는 엔드포인트의 주소를 바꾸려면 새 키를 넣거나 키를 지워야 합니다.`,
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
        Schema.is(rejectedStatuses)(failure.status)
          ? i18n._(rejectedStatusText[failure.status])
          : failure.message,
    },
    () => failure.message,
  );
};

export type CompatibleHandlers = {
  readonly onChange: (change: CompatibleAccountChange) => Promise<void>;
  readonly onTest: (accountId: string, modelId: string) => Promise<void>;
  readonly onDiscover: (accountId: string) => Promise<readonly string[]>;
};

const newModel = (id = "", imageInput = false): CompatibleModelInput => ({
  id,
  contextWindow: 32768,
  outputBudget: null,
  toolCalling: true,
  imageInput,
});

/** The limit a turned-on output limit starts from. */
const initialOutputBudget = 4096;

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
  busy,
  onDiscover,
  onSave,
  onClose,
}: {
  initial: CompatibleModelInput;
  busy: boolean;
  onDiscover: () => Promise<readonly string[]>;
  onSave: (model: CompatibleModelInput) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [model, setModel] = useState(initial);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<string | null>(null);
  const idPrefix = useId();
  const discover = () => {
    setDiscovering(true);
    setDiscovery(null);
    void onDiscover()
      .then(
        (ids) => {
          setSuggestions(ids);
          setDiscovery(
            t({
              message: `${ph({ count: ids.length })}개 모델을 불러왔습니다. 목록에 없는 ID도 직접 입력할 수 있습니다.`,
              comment: "count is how many models the server listed",
            }),
          );
        },
        (failure: Error) => setDiscovery(compatibleErrorMessage(failure)),
      )
      .finally(() => setDiscovering(false));
  };
  return (
    <form
      aria-label={t({ message: "모델 등록", comment: "Label of the form that registers a model" })}
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...model, id: model.id.trim() });
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
            {suggestions.slice(0, 20).map((id) => (
              <Button
                key={id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setModel({ ...model, id })}
              >
                {id}
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
            type="number"
            required
            min={1024}
            max={10000000}
            step={1}
            value={model.contextWindow}
            onChange={(event) => setModel({ ...model, contextWindow: Number(event.target.value) })}
          />
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
              max={model.contextWindow - 1}
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
      <div className="flex items-center gap-2">
        <Switch
          id={`${idPrefix}-image-input`}
          checked={model.imageInput}
          onCheckedChange={(imageInput) => setModel({ ...model, imageInput })}
        />
        <FieldLabel htmlFor={`${idPrefix}-image-input`}>
          <Trans>이미지 입력 지원</Trans>
        </FieldLabel>
        <FieldDescription>
          <Trans>
            끄면 이미지를 보낼 수 없습니다. 이미지가 있던 대화는 글 메모로 이어 보냅니다.
          </Trans>
        </FieldDescription>
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="outline" onClick={onClose}>
          <Trans comment="Button that closes the model form">취소</Trans>
        </Button>
        <Button type="submit" disabled={busy || model.id.trim() === ""}>
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
  model: { readonly initial: CompatibleModelInput };
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
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium">{account.label}</span>
              {current && (
                <Badge variant="outline">
                  <Trans comment="Badge on the account chats run on now">사용 중</Trans>
                </Badge>
              )}
            </span>
            <span className="truncate text-2xs text-muted-foreground">
              {account.baseUrl} ·{" "}
              {account.hasApiKey ? (
                <Trans comment="Endpoint status: an API key is saved">키 있음</Trans>
              ) : (
                <Trans comment="Endpoint status: no API key is saved">키 없음</Trans>
              )}
            </span>
          </div>
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
          const contextWindow = model.contextWindow.toLocaleString();
          const output =
            model.outputBudget === null
              ? t({ message: "제한 없음", comment: "Model output limit: none set" })
              : model.outputBudget.toLocaleString();
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
                  const { reasoning: _reasoning, imageInputSource: _source, ...input } = model;
                  setMode(
                    CardMode.model({
                      initial: { ...input, imageInput: input.imageInput === true },
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
            onClick={() => setMode(CardMode.model({ initial: newModel() }))}
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
          compatibleClient.discover(accountId).then(({ models }) => models.map(({ id }) => id)),
      }}
    />
  );
}
