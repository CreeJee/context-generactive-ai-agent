import { Schema } from "effect";
import { cn } from "cn";
import { CheckIcon, PencilIcon, PlugIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
  type CompatibleAccountChange,
  type CompatibleAccountStatus,
  type CompatibleModelInput,
} from "./compatible-client";

/** Safe text for a failed endpoint request; upstream bodies are never shown. */
export const compatibleErrorMessage = (failure: Error) => {
  if (!Schema.is(CompatibleRequestFailed)(failure)) return "호환 공급자 요청에 실패했어요.";
  switch (failure.reason._tag) {
    case "PartialWrite":
    case "TransportFailed":
    case "InvalidResponse":
      return failure.message;
    case "RequestRejected":
      switch (failure.status) {
        case 400:
          return "주소, 키 또는 모델 한도를 확인하세요. 키가 있는 엔드포인트의 주소를 바꾸려면 새 키를 넣거나 키를 지워야 해요.";
        case 404:
          return "엔드포인트나 모델을 찾지 못했어요. 목록을 새로고침하세요.";
        case 502:
          return "엔드포인트가 응답하지 않았어요. 주소와 서버 상태를 확인하세요.";
        default:
          return failure.message;
      }
  }
};

export type CompatibleHandlers = {
  readonly onChange: (change: CompatibleAccountChange) => Promise<void>;
  readonly onTest: (accountId: string, modelId: string) => Promise<void>;
  readonly onDiscover: (accountId: string) => Promise<readonly string[]>;
};

const newModel = (id = ""): CompatibleModelInput => ({
  id,
  contextWindow: 32768,
  outputBudget: null,
  toolCalling: true,
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
        <FieldDescription>/chat/completions 경로는 자동으로 붙어요.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-key`}>API 키 (선택)</FieldLabel>
        <Input
          id={`${idPrefix}-key`}
          type="password"
          autoComplete="off"
          value={apiKey}
          disabled={removeKey}
          placeholder={hasApiKey ? "등록된 키 유지" : "키 없는 로컬 서버도 연결할 수 있어요"}
          onChange={(event) => onApiKey(event.target.value)}
        />
        <FieldDescription>키는 OS 키체인에만 저장되고 다시 표시되지 않아요.</FieldDescription>
        {hasApiKey && (
          <div className="flex items-center gap-2">
            <Switch
              id={`${idPrefix}-remove-key`}
              checked={removeKey}
              onCheckedChange={onRemoveKey}
            />
            <FieldLabel htmlFor={`${idPrefix}-remove-key`}>저장할 때 기존 키 삭제</FieldLabel>
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
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const labelId = useId();
  return (
    <form
      aria-label="새 OpenAI 호환 엔드포인트"
      className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate({
          intent: "create",
          baseUrl: baseUrl.trim(),
          ...(label.trim() !== "" && { label: label.trim() }),
          ...keyChange(apiKey, false),
        }).then(onClose, () => {});
      }}
    >
      <Field>
        <FieldLabel htmlFor={labelId}>이름 (선택)</FieldLabel>
        <Input
          id={labelId}
          value={label}
          maxLength={80}
          placeholder="비워 두면 서버 주소로 불러요"
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
        <Button type="button" variant="ghost-muted" onClick={onClose}>
          취소
        </Button>
        <Button type="submit" variant="outline" disabled={busy || baseUrl.trim() === ""}>
          추가
        </Button>
      </div>
    </form>
  );
}

function ModelForm({
  initial,
  suggestions,
  busy,
  onSave,
  onClose,
}: {
  initial: CompatibleModelInput;
  suggestions: readonly string[];
  busy: boolean;
  onSave: (model: CompatibleModelInput) => void;
  onClose: () => void;
}) {
  const [model, setModel] = useState(initial);
  const idPrefix = useId();
  return (
    <form
      aria-label="모델 등록"
      className="flex flex-col gap-3 rounded-md border border-dashed p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...model, id: model.id.trim() });
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-id`}>모델 ID</FieldLabel>
        <Input
          id={`${idPrefix}-id`}
          required
          value={model.id}
          onChange={(event) => setModel({ ...model, id: event.target.value })}
        />
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="서버의 모델">
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
        <FieldDescription>서버에서 쓰는 정확한 ID를 입력하세요.</FieldDescription>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-context`}>컨텍스트 창 (토큰)</FieldLabel>
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
            <FieldLabel htmlFor={`${idPrefix}-output-limit`}>최대 출력 토큰 제한</FieldLabel>
          </div>
          {model.outputBudget === null ? (
            <FieldDescription>
              제한 없음: 서버의 한도까지 출력해요. 추론 모델은 추론도 이 한도를 써요.
            </FieldDescription>
          ) : (
            <Input
              id={`${idPrefix}-output`}
              aria-label="최대 출력 토큰"
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
        <FieldLabel htmlFor={`${idPrefix}-tools`}>도구 호출 지원</FieldLabel>
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost-muted" onClick={onClose}>
          취소
        </Button>
        <Button type="submit" variant="outline" disabled={busy || model.id.trim() === ""}>
          모델 저장
        </Button>
      </div>
    </form>
  );
}

type CardMode =
  | { readonly type: "view" }
  | { readonly type: "rename" }
  | { readonly type: "connect" }
  | { readonly type: "model"; readonly initial: CompatibleModelInput };

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
  const [mode, setMode] = useState<CardMode>({ type: "view" });
  const [label, setLabel] = useState(account.label);
  const [baseUrl, setBaseUrl] = useState(account.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (task: () => Promise<void>, done?: string) => {
    setMessage(null);
    setError(null);
    return task().then(
      () => {
        if (done !== undefined) setMessage(done);
        setMode({ type: "view" });
      },
      (failure: Error) => setError(compatibleErrorMessage(failure)),
    );
  };
  const change = (next: CompatibleAccountChange, done?: string) =>
    run(() => handlers.onChange(next), done);
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-lg border px-3 py-2.5",
        current && "border-primary/50",
      )}
      aria-label={`${account.label} (OpenAI 호환)`}
    >
      {mode.type === "rename" ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim() === "") return;
            void change({ intent: "rename", accountId: account.id, label: label.trim() });
          }}
        >
          <Input
            aria-label="계정 이름"
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setMode({ type: "view" })}
            autoFocus
          />
          <Button type="submit" variant="ghost" size="icon" aria-label="이름 저장">
            <CheckIcon />
          </Button>
          <Button
            type="button"
            variant="ghost-muted"
            size="icon"
            aria-label="이름 변경 취소"
            onClick={() => {
              setLabel(account.label);
              setMode({ type: "view" });
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
              {current && <Badge variant="outline">사용 중</Badge>}
            </span>
            <span className="truncate text-2xs text-muted-foreground">
              {account.baseUrl} · {account.hasApiKey ? "키 있음" : "키 없음"}
            </span>
          </div>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={`${account.label} 이름 변경`}
            onClick={() => setMode({ type: "rename" })}
          >
            <PencilIcon /> 이름 변경
          </Button>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={`${account.label} 연결 수정`}
            onClick={() => setMode({ type: "connect" })}
          >
            <PlugIcon /> 연결
          </Button>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={`${account.label} 삭제`}
            disabled={busy}
            onClick={() => {
              if (window.confirm(`${account.label} 엔드포인트와 저장한 키를 지울까요?`))
                void change({ intent: "remove", accountId: account.id });
            }}
          >
            <Trash2Icon /> 삭제
          </Button>
        </div>
      )}
      {mode.type === "connect" && (
        <form
          aria-label={`${account.label} 연결`}
          className="flex flex-col gap-3 rounded-md border border-dashed p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void change(
              {
                intent: "connect",
                accountId: account.id,
                baseUrl: baseUrl.trim(),
                ...keyChange(apiKey, removeKey),
              },
              "연결을 저장했어요.",
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
            <Button type="button" variant="ghost-muted" onClick={() => setMode({ type: "view" })}>
              취소
            </Button>
            <Button type="submit" variant="outline" disabled={busy}>
              연결 저장
            </Button>
          </div>
        </form>
      )}
      <ul className="flex flex-col gap-1" aria-label={`${account.label} 모델`}>
        {account.models.map((model) => (
          <li key={model.id} className="flex min-w-0 items-center gap-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{model.id}</span>
              <span className="text-muted-foreground">
                {" "}
                · {model.contextWindow.toLocaleString()} / 출력{" "}
                {model.outputBudget === null ? "제한 없음" : model.outputBudget.toLocaleString()} ·
                도구 {model.toolCalling ? "켬" : "끔"}
              </span>
            </span>
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => handlers.onTest(account.id, model.id),
                  `${model.id} 연결을 확인했어요.`,
                )
              }
            >
              테스트
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label={`${model.id} 수정`}
              onClick={() => {
                const { reasoning: _reasoning, ...input } = model;
                setMode({ type: "model", initial: input });
              }}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label={`${model.id} 삭제`}
              disabled={busy}
              onClick={() =>
                void change({ intent: "remove-model", accountId: account.id, modelId: model.id })
              }
            >
              <XIcon />
            </Button>
          </li>
        ))}
        {account.models.length === 0 && (
          <li className="text-xs text-muted-foreground">
            등록한 모델이 없어요. 모델을 추가해야 이 엔드포인트로 대화할 수 있어요.
          </li>
        )}
      </ul>
      {mode.type === "model" ? (
        <ModelForm
          key={mode.initial.id}
          initial={mode.initial}
          suggestions={suggestions}
          busy={busy}
          onSave={(model) =>
            void change(
              { intent: "save-model", accountId: account.id, model },
              "모델을 저장했어요.",
            )
          }
          onClose={() => setMode({ type: "view" })}
        />
      ) : (
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMode({ type: "model", initial: newModel() })}
          >
            <PlusIcon /> 모델 추가
          </Button>
          <Button
            variant="ghost-muted"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() =>
                handlers.onDiscover(account.id).then((ids) => {
                  setSuggestions(ids);
                  setMessage(
                    `${ids.length}개 모델을 불러왔어요. 목록에 없어도 ID를 직접 입력할 수 있어요.`,
                  );
                }),
              ).then(() => setMode({ type: "model", initial: newModel() }))
            }
          >
            서버 모델 불러오기
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
  const [adding, setAdding] = useState(false);
  return (
    <section aria-label="OpenAI 호환" className="flex flex-col gap-3 py-5">
      <ProviderHeader
        provider="openai-compatible"
        description="Chat Completions 호환 서버를 엔드포인트마다 등록하고, 쓸 모델을 직접 추가해요. 공급자의 API 요금이 적용될 수 있어요."
      >
        <Button
          variant="outline"
          size="sm"
          aria-label="OpenAI 호환 엔드포인트 추가"
          disabled={adding || busy}
          onClick={() => setAdding(true)}
        >
          <PlusIcon /> 엔드포인트 추가
        </Button>
      </ProviderHeader>
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>엔드포인트 목록을 불러오지 못했어요.</AlertDescription>
        </Alert>
      )}
      {accounts === undefined ? (
        !failed && <Spinner />
      ) : accounts.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="OpenAI 호환 엔드포인트 목록">
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
        !adding && <p className="text-xs text-muted-foreground">추가한 엔드포인트가 없어요.</p>
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
