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
import { navigationCopy } from "./copy";
import { providerLabels } from "./providers";

const copy = navigationCopy.compatible;

const rejectedStatuses = Schema.Literals([400, 404, 502]);
/** What a rejected endpoint request means, by the status codes the server answers with. */
const rejectedStatusText: Readonly<Record<typeof rejectedStatuses.Type, string>> = copy.rejected;

/** Safe text for a failed endpoint request; upstream bodies are never shown. */
export const compatibleErrorMessage = (failure: Error) => {
  if (!Schema.is(CompatibleRequestFailed)(failure)) return copy.requestFailed;
  return CompatibleRequestFailedReason.matchOrElse(
    failure.reason,
    {
      RequestRejected: () =>
        Schema.is(rejectedStatuses)(failure.status)
          ? rejectedStatusText[failure.status]
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
        <FieldDescription>{copy.connection.pathHint}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-key`}>{copy.connection.key}</FieldLabel>
        <Input
          id={`${idPrefix}-key`}
          type="password"
          autoComplete="off"
          value={apiKey}
          disabled={removeKey}
          placeholder={hasApiKey ? copy.connection.keyKept : copy.connection.keyOptional}
          onChange={(event) => onApiKey(event.target.value)}
        />
        <FieldDescription>{copy.connection.keyHint}</FieldDescription>
        {hasApiKey && (
          <div className="flex items-center gap-2">
            <Switch
              id={`${idPrefix}-remove-key`}
              checked={removeKey}
              onCheckedChange={onRemoveKey}
            />
            <FieldLabel htmlFor={`${idPrefix}-remove-key`}>{copy.connection.removeKey}</FieldLabel>
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
      aria-label={copy.addEndpoint.form}
      className="flex flex-col gap-3 rounded-lg border px-3 py-3"
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
        <FieldLabel htmlFor={labelId}>{copy.addEndpoint.name}</FieldLabel>
        <Input
          id={labelId}
          value={label}
          maxLength={80}
          placeholder={copy.addEndpoint.namePlaceholder}
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
          {copy.addEndpoint.cancel}
        </Button>
        <Button type="submit" disabled={busy || baseUrl.trim() === ""}>
          {copy.addEndpoint.submit}
        </Button>
      </div>
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
          setDiscovery(copy.modelForm.discovered(ids.length));
        },
        (failure: Error) => setDiscovery(compatibleErrorMessage(failure)),
      )
      .finally(() => setDiscovering(false));
  };
  return (
    <form
      aria-label={copy.modelForm.form}
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...model, id: model.id.trim() });
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-id`}>{copy.modelForm.id}</FieldLabel>
        <div className="flex gap-1">
          <Input
            id={`${idPrefix}-id`}
            required
            value={model.id}
            onChange={(event) => setModel({ ...model, id: event.target.value })}
          />
          <Button type="button" variant="outline" disabled={busy || discovering} onClick={discover}>
            {discovering && <Spinner />} {copy.modelForm.discover}
          </Button>
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label={copy.modelForm.suggestions}>
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
        <FieldDescription>{copy.modelForm.idHint}</FieldDescription>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-context`}>{copy.modelForm.contextWindow}</FieldLabel>
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
              {copy.modelForm.outputLimit}
            </FieldLabel>
          </div>
          {model.outputBudget === null ? (
            <FieldDescription>{copy.modelForm.unlimitedHint}</FieldDescription>
          ) : (
            <Input
              id={`${idPrefix}-output`}
              aria-label={copy.modelForm.outputTokens}
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
        <FieldLabel htmlFor={`${idPrefix}-tools`}>{copy.modelForm.toolCalling}</FieldLabel>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={`${idPrefix}-image-input`}
          checked={model.imageInput}
          onCheckedChange={(imageInput) => setModel({ ...model, imageInput })}
        />
        <FieldLabel htmlFor={`${idPrefix}-image-input`}>{copy.modelForm.imageInput}</FieldLabel>
        <FieldDescription>{copy.modelForm.imageInputHint}</FieldDescription>
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="outline" onClick={onClose}>
          {copy.modelForm.cancel}
        </Button>
        <Button type="submit" disabled={busy || model.id.trim() === ""}>
          {copy.modelForm.save}
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
  const endpoint = copy.endpoint;
  const removeConfirm = endpoint.removeConfirm(account.label);
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-lg border px-3 py-2.5",
        current && "border-primary/50",
      )}
      aria-label={endpoint.row(account.label)}
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
            aria-label={navigationCopy.rename.field}
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
            aria-label={navigationCopy.rename.save}
          >
            <CheckIcon />
          </Button>
          <Button
            type="button"
            variant="ghost-muted"
            size="icon"
            aria-label={navigationCopy.rename.cancel}
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
              {current && <Badge variant="outline">{navigationCopy.inUse}</Badge>}
            </span>
            <span className="truncate text-2xs text-muted-foreground">
              {account.baseUrl} · {account.hasApiKey ? endpoint.hasKey : endpoint.noKey}
            </span>
          </div>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={navigationCopy.rename.openFor(account.label)}
            onClick={() => setMode(CardMode.rename())}
          >
            <PencilIcon /> {navigationCopy.rename.open}
          </Button>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={endpoint.connectFor(account.label)}
            onClick={() => setMode(CardMode.connect())}
          >
            <PlugIcon /> {endpoint.connect}
          </Button>
          <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="sm"
                  aria-label={endpoint.removeFor(account.label)}
                  disabled={busy}
                />
              }
            >
              <Trash2Icon /> {endpoint.remove}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{removeConfirm.title}</AlertDialogTitle>
                <AlertDialogDescription>{removeConfirm.body}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{removeConfirm.choices.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    setConfirmingRemove(false);
                    void change({ intent: "remove", accountId: account.id });
                  }}
                >
                  {removeConfirm.choices.remove}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
      {CardMode.$is("connect")(mode) && (
        <form
          aria-label={endpoint.connectionForm(account.label)}
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
              endpoint.connectionSaved,
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
              {endpoint.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {endpoint.saveConnection}
            </Button>
          </div>
        </form>
      )}
      <ul className="flex flex-col gap-1" aria-label={endpoint.models(account.label)}>
        {account.models.map((model) => (
          <li key={model.id} className="flex min-w-0 items-center gap-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{model.id}</span>
              <span className="text-muted-foreground">
                {" "}
                ·{" "}
                {endpoint.modelSpec(
                  model.contextWindow.toLocaleString(),
                  model.outputBudget === null
                    ? endpoint.unlimited
                    : model.outputBudget.toLocaleString(),
                  model.toolCalling ? endpoint.toolsOn : endpoint.toolsOff,
                )}
                {model.imageInput === true && ` · ${endpoint.image}`}
              </span>
            </span>
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() => handlers.onTest(account.id, model.id), endpoint.tested(model.id))
              }
            >
              {endpoint.test}
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label={endpoint.editModel(model.id)}
              onClick={() => {
                const { reasoning: _reasoning, imageInputSource: _source, ...input } = model;
                setMode(
                  CardMode.model({ initial: { ...input, imageInput: input.imageInput === true } }),
                );
              }}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label={endpoint.removeFor(model.id)}
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
          <li className="text-xs text-muted-foreground">{endpoint.noModels}</li>
        )}
      </ul>
      {CardMode.$is("model")(mode) ? (
        <ModelForm
          key={mode.initial.id}
          initial={mode.initial}
          busy={busy}
          onDiscover={() => handlers.onDiscover(account.id)}
          onSave={(model) =>
            void change({ intent: "save-model", accountId: account.id, model }, endpoint.modelSaved)
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
            <PlusIcon /> {endpoint.addModel}
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
    <section aria-label={providerLabels["openai-compatible"]} className="flex flex-col gap-3 py-5">
      <ProviderHeader provider="openai-compatible" description={copy.list.description}>
        <Button
          variant="outline"
          size="sm"
          aria-label={copy.list.addFor}
          disabled={adding || busy}
          onClick={() => setAdding(true)}
        >
          <PlusIcon /> {copy.list.add}
        </Button>
      </ProviderHeader>
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>{copy.list.failed}</AlertDescription>
        </Alert>
      )}
      {accounts === undefined ? (
        !failed && <Spinner />
      ) : accounts.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={copy.list.list}>
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
        !adding && <p className="text-xs text-muted-foreground">{copy.list.empty}</p>
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
