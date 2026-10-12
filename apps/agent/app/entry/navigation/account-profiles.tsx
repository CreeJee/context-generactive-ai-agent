import { Meter } from "@base-ui/react/meter";
import { cn } from "cn";
import {
  CheckIcon,
  ChevronRightIcon,
  LogOutIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
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
  type AccountAction,
  type AccountsView,
  type OAuthProfile,
  type ProviderAuthState,
  type ProviderId,
  type SubscriptionAccountProvider,
  type SubscriptionQuotaReport,
} from "../api";
import { useAccountQuotaQuery, useAccountsQuery } from "../queries/global";
import { useAccountActionMutation } from "../queries/mutations/global";
import { koreanShortTime } from "../shared/local-time";
import { providerLabels } from "./providers";

type QuotaStatus = SubscriptionQuotaReport["accounts"][number]["quota"];
type QuotaWindow = Extract<QuotaStatus, { status: "observed" }>["windows"][number];

/**
 * Anthropic names its windows; OpenAI reports `primary`/`secondary` with a length, which labels
 * them. A window with neither is shown by the name the provider sent.
 */
export const windowLabel = (window: Pick<QuotaWindow, "name" | "windowSeconds">) => {
  switch (window.name) {
    case "five_hour":
      return "5시간";
    case "seven_day":
      return "7일";
    default: {
      if (window.windowSeconds === null) return window.name;
      const hours = Math.round(window.windowSeconds / 3600);
      return hours < 24 ? `${hours}시간` : `${Math.round(hours / 24)}일`;
    }
  }
};

/** Why a quota has no numbers; the app never estimates one. */
export function quotaUnavailableText(
  reason: Extract<QuotaStatus, { status: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "credential_expired":
      return "구독 한도 조회 불가: 저장된 로그인이 만료돼 조회하지 않았어요";
    case "lookup_failed":
      return "구독 한도 조회 실패: 공급자에서 사용량을 받지 못했어요";
  }
}

export const gaugeTone = (usedPercent: number) =>
  usedPercent >= 90 ? "bg-destructive" : usedPercent >= 70 ? "bg-warning" : "bg-primary";

/** One provider-reported window as a gauge; a stale value is dimmed rather than hidden. */
function QuotaGauge({ window, stale }: { window: QuotaWindow; stale: boolean }) {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const resetsAt = window.resetsAt !== null && window.resetsAt !== "" ? window.resetsAt : null;
  return (
    <Meter.Root
      value={used}
      className="col-span-3 grid grid-cols-subgrid items-center gap-y-0.5"
      getAriaValueText={() => `${Math.round(used)}% 사용`}
    >
      <Meter.Label className="text-2xs text-muted-foreground">{windowLabel(window)}</Meter.Label>
      <Meter.Track className="h-1.5 overflow-hidden rounded-full bg-muted">
        <Meter.Indicator
          className={cn(
            "h-full rounded-full transition-all",
            gaugeTone(used),
            stale && "opacity-40",
          )}
        />
      </Meter.Track>
      <span className="text-right text-2xs tabular-nums">{Math.round(used)}%</span>
      {resetsAt !== null && (
        <span className="col-start-2 col-span-2 text-2xs text-muted-foreground">
          {koreanShortTime(resetsAt)} 초기화
        </span>
      )}
    </Meter.Root>
  );
}

function QuotaGauges({
  quota,
  failed,
}: {
  quota: QuotaStatus | undefined;
  /** The status request itself failed, which is not the same as an unavailable quota. */
  failed: boolean;
}) {
  if (failed)
    return <p className="text-2xs text-muted-foreground">한도 상태를 확인하지 못했어요</p>;
  if (quota === undefined) return <p className="text-2xs text-muted-foreground">한도 확인 중</p>;
  switch (quota.status) {
    case "unavailable":
      return <p className="text-2xs text-muted-foreground">{quotaUnavailableText(quota.reason)}</p>;
    case "observed":
    case "stale":
      return (
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-[auto_1fr_2.5rem] gap-x-2 gap-y-1">
            {quota.windows.map((window) => (
              <QuotaGauge key={window.name} window={window} stale={quota.status === "stale"} />
            ))}
          </div>
          <p className="text-2xs text-muted-foreground">
            {quota.status === "stale"
              ? `최근 조회 실패 · ${koreanShortTime(quota.observedAt)} 기준 값`
              : `${koreanShortTime(quota.observedAt)} 조회`}
          </p>
        </div>
      );
  }
}

/** First letters collide (ChatGPT, Claude), so each provider has its own mark. */
const providerMark = (provider: SubscriptionAccountProvider) => {
  switch (provider) {
    case "openai":
      return "G";
    case "anthropic":
      return "A";
  }
};

export function ProviderMark({ provider }: { provider: ProviderId }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
        provider === "openai" && "bg-foreground text-background",
        provider === "anthropic" && "bg-warning/20 text-warning",
        provider === "openai-compatible" && "bg-muted text-muted-foreground",
      )}
    >
      {provider === "openai-compatible" ? (
        <PlugIcon className="size-3.5" />
      ) : (
        providerMark(provider)
      )}
    </span>
  );
}

/** Provider type and the user's name for the account, read together on one line. */
export function AccountName({ provider, label }: { provider: ProviderId; label: string }) {
  return (
    <span className="min-w-0 flex-1 truncate text-xs">
      <span className="text-muted-foreground">{providerLabels[provider]} · </span>
      <span className="font-medium">{label}</span>
    </span>
  );
}

const rowLabel = (provider: ProviderId, label: string) => `${label} (${providerLabels[provider]})`;

function ProfileRow({
  provider,
  profile,
  current,
  quota,
  quotaFailed,
  busy,
  onAction,
}: {
  provider: SubscriptionAccountProvider;
  profile: OAuthProfile;
  /** The account chats run on now: the selected profile of the provider in use. */
  current: boolean;
  quota: QuotaStatus | undefined;
  quotaFailed: boolean;
  busy: boolean;
  onAction: (action: AccountAction) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(profile.label);
  const cancelRename = () => {
    setLabel(profile.label);
    setRenaming(false);
  };
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-md border px-2 py-1.5",
        current && "border-primary/50 bg-primary/5",
      )}
      aria-label={rowLabel(provider, profile.label)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ProviderMark provider={provider} />
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (label.trim() === "") return;
              onAction({ intent: "rename", accountId: profile.id, label: label.trim() });
              setRenaming(false);
            }}
          >
            <Input
              aria-label="계정 이름"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && cancelRename()}
              autoFocus
            />
            <Button type="submit" variant="ghost" size="icon-xs" aria-label="이름 저장">
              <CheckIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="이름 변경 취소"
              onClick={cancelRename}
            >
              <XIcon />
            </Button>
          </form>
        ) : (
          <>
            <AccountName provider={provider} label={profile.label} />
            {current && <Badge variant="secondary">사용 중</Badge>}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${profile.label} 이름 변경`}
              title="이름 변경"
              onClick={() => setRenaming(true)}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${profile.label} 로그아웃`}
              title="로그아웃"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `${profile.label} 계정에서 로그아웃하고 이 앱의 목록에서 지울까요?`,
                  )
                )
                  onAction({ intent: "remove", accountId: profile.id });
              }}
            >
              <LogOutIcon />
            </Button>
          </>
        )}
      </div>
      <QuotaGauges quota={quota} failed={quotaFailed} />
    </li>
  );
}

/** The provider's connection failure with its diagnostic fields folded away. */
function AuthErrorAlert({ auth }: { auth: Extract<ProviderAuthState, { status: "error" }> }) {
  return (
    <Alert variant="destructive" className="min-w-0">
      <AlertDescription className="min-w-0 wrap-break-word">
        {providerLabels[auth.provider]}: {auth.message}
        {(auth.code || auth.httpStatus || auth.providerCode) && (
          <Collapsible className="mt-2 text-2xs">
            <CollapsibleTrigger className="group flex items-center gap-1 text-left">
              <ChevronRightIcon
                aria-hidden="true"
                className="size-3 transition-transform group-data-[panel-open]:rotate-90"
              />
              진단 정보
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 space-y-0.5 break-all font-mono">
              {auth.code && <div>code: {auth.code}</div>}
              {auth.operation && <div>operation: {auth.operation}</div>}
              {auth.httpStatus && <div>HTTP: {auth.httpStatus}</div>}
              {auth.providerCode && <div>provider code: {auth.providerCode}</div>}
              {auth.credentialStage && <div>credential stage: {auth.credentialStage}</div>}
              {auth.transportCode && <div>transport code: {auth.transportCode}</div>}
              {auth.proxyRoute && <div>proxy route: {auth.proxyRoute}</div>}
            </CollapsibleContent>
          </Collapsible>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** One subscription provider's accounts as the manager list needs them. */
export type ProviderAccounts = {
  readonly provider: SubscriptionAccountProvider;
  readonly auth: ProviderAuthState | null;
  readonly view: AccountsView | undefined;
  readonly quota: SubscriptionQuotaReport | undefined;
  readonly quotaFailed: boolean;
  readonly busy: boolean;
};

const subscriptionProviders = [
  { value: "openai", label: providerLabels.openai },
  { value: "anthropic", label: providerLabels.anthropic },
] satisfies { value: SubscriptionAccountProvider; label: string }[];

function AddAccountForm({
  busy,
  onAdd,
  onClose,
}: {
  busy: boolean;
  onAdd: (provider: SubscriptionAccountProvider, label: string) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<SubscriptionAccountProvider>("openai");
  const [label, setLabel] = useState("");
  return (
    <form
      aria-label="새 계정"
      className="flex flex-col gap-2 rounded-md border border-dashed p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (label.trim() === "") return;
        onAdd(provider, label.trim());
        onClose();
      }}
    >
      <div className="flex items-center gap-1">
        <Select
          value={provider}
          items={subscriptionProviders}
          onValueChange={(value) => {
            const next = subscriptionProviders.find((option) => option.value === value);
            if (next !== undefined) setProvider(next.value);
          }}
        >
          <SelectTrigger size="sm" aria-label="새 계정 공급자">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {subscriptionProviders.map(({ value, label: name }) => (
              <SelectItem key={value} value={value}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="새 계정 이름"
          placeholder="계정 이름 (예: 개인, 회사)"
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && onClose()}
          autoFocus
        />
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
          취소
        </Button>
        <Button type="submit" variant="outline" size="xs" disabled={busy || label.trim() === ""}>
          {providerLabels[provider]}로 로그인
        </Button>
      </div>
    </form>
  );
}

/**
 * Every account in one list, whatever its provider: rename, log out and add here. Switching
 * belongs to the sidebar switcher, so this list only edits.
 */
export function AccountManagerList({
  providers,
  activeProvider,
  compatibleConfigured,
  error,
  onAction,
  onConfigureCompatible,
}: {
  providers: readonly ProviderAccounts[];
  activeProvider: ProviderId;
  compatibleConfigured: boolean;
  error: string | null;
  onAction: (provider: SubscriptionAccountProvider, action: AccountAction) => void;
  onConfigureCompatible: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const loading = providers.some((group) => group.view === undefined);
  const quotaOf = (group: ProviderAccounts, id: string) =>
    group.quota?.accounts.find((account) => account.accountId === id)?.quota;
  return (
    <div className="flex flex-col gap-2">
      {providers.map(
        (group) =>
          group.auth?.status === "error" && (
            <AuthErrorAlert key={group.provider} auth={group.auth} />
          ),
      )}
      <ul className="flex flex-col gap-1" aria-label="계정 목록">
        {providers.flatMap((group) =>
          (group.view?.profiles ?? []).map((profile) => (
            <ProfileRow
              key={profile.id}
              provider={group.provider}
              profile={profile}
              current={activeProvider === group.provider && profile.selected}
              quota={quotaOf(group, profile.id)}
              quotaFailed={group.quotaFailed}
              busy={group.busy}
              onAction={(action) => onAction(group.provider, action)}
            />
          )),
        )}
        <li
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5",
            activeProvider === "openai-compatible" && "border-primary/50 bg-primary/5",
          )}
          aria-label={rowLabel("openai-compatible", "직접 설정한 엔드포인트")}
        >
          <ProviderMark provider="openai-compatible" />
          <AccountName provider="openai-compatible" label="직접 설정한 엔드포인트" />
          {activeProvider === "openai-compatible" ? (
            <Badge variant="secondary">사용 중</Badge>
          ) : (
            !compatibleConfigured && <Badge variant="outline">설정 필요</Badge>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="호환 공급자 설정"
            title="호환 공급자 설정"
            onClick={onConfigureCompatible}
          >
            <Settings2Icon />
          </Button>
        </li>
      </ul>
      {loading && <Spinner />}
      {providers.map(({ provider, view }) => {
        switch (view?.login.status) {
          case "pending": {
            const { authorizationUrl } = view.login;
            return (
              <div key={provider} className="flex flex-col gap-1.5 text-xs">
                <span className="flex items-center gap-2">
                  <Spinner /> 브라우저에서 {providerLabels[provider]} 로그인을 완료하세요
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(authorizationUrl, "_blank", "noopener")}
                  >
                    로그인 창 다시 열기
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onAction(provider, { intent: "cancel" })}
                  >
                    취소
                  </Button>
                </div>
              </div>
            );
          }
          case "error":
            return (
              <Alert key={provider} variant="destructive">
                <AlertDescription>
                  {providerLabels[provider]} 새 계정 로그인을 완료하지 못했어요. 다시 시도하세요.
                </AlertDescription>
              </Alert>
            );
          case "idle":
          case "completed":
          case undefined:
            return null;
        }
      })}
      {adding ? (
        <AddAccountForm
          busy={providers.some((group) => group.busy)}
          onAdd={(provider, label) => onAction(provider, { intent: "add", label })}
          onClose={() => setAdding(false)}
        />
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <PlusIcon /> 계정 추가
        </Button>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

const accountErrorMessage = (error: Error) => {
  if (!isApiError(error)) return "계정 작업에 실패했어요.";
  switch (error.code) {
    case "invalid_account_label":
      return "계정 이름은 1~80자로 입력하세요.";
    case "account_action_failed":
      return "계정 작업을 완료하지 못했어요. 이 계정의 실행이 끝난 뒤 다시 시도하세요.";
    default:
      return "계정 작업에 실패했어요.";
  }
};

/** Loads and changes one subscription provider's accounts. */
function useProviderAccounts(
  provider: SubscriptionAccountProvider,
  auth: ProviderAuthState | null,
) {
  const accounts = useAccountsQuery(provider, true);
  const quota = useAccountQuotaQuery(provider, true);
  const action = useAccountActionMutation(provider);
  const profileCount = accounts.data?.profiles.length;
  const refetchQuota = quota.refetch;
  // A login finished in another tab adds a profile whose quota row is not loaded yet.
  useEffect(() => {
    if (profileCount !== undefined) void refetchQuota();
  }, [profileCount, refetchQuota]);
  const group: ProviderAccounts = {
    provider,
    auth,
    view: accounts.data,
    quota: quota.data,
    quotaFailed: quota.isError,
    busy: action.isPending,
  };
  return { group, failed: accounts.isError, run: action.mutateAsync };
}

/** Every subscription account and the compatible endpoint, mounted only while the sheet is open. */
export function AccountManager({
  auth,
  activeProvider,
  compatibleConfigured,
  onConfigureCompatible,
}: {
  auth: Record<SubscriptionAccountProvider, ProviderAuthState | null>;
  activeProvider: ProviderId;
  compatibleConfigured: boolean;
  onConfigureCompatible: () => void;
}) {
  const openai = useProviderAccounts("openai", auth.openai);
  const anthropic = useProviderAccounts("anthropic", auth.anthropic);
  const [error, setError] = useState<string | null>(null);
  const runners = { openai: openai.run, anthropic: anthropic.run };
  return (
    <AccountManagerList
      providers={[openai.group, anthropic.group]}
      activeProvider={activeProvider}
      compatibleConfigured={compatibleConfigured}
      error={error ?? (openai.failed || anthropic.failed ? "계정 목록을 불러오지 못했어요." : null)}
      onConfigureCompatible={onConfigureCompatible}
      onAction={(provider, next) => {
        setError(null);
        runners[provider](next).then(
          (view) => {
            if (next.intent === "add" && view.login.status === "pending")
              window.open(view.login.authorizationUrl, "_blank", "noopener");
          },
          (failure) =>
            setError(
              accountErrorMessage(failure instanceof Error ? failure : new Error(String(failure))),
            ),
        );
      }}
    />
  );
}
