import { Meter } from "@base-ui/react/meter";
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { cn } from "cn";
import { Data, DateTime } from "effect";
import {
  CheckIcon,
  ChevronRightIcon,
  CpuIcon,
  LogOutIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import claudeIcon from "~/assets/providers/claude.svg";
import codexIcon from "~/assets/providers/codex.svg";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import {
  type ApiError,
  isApiError,
  AccountLoginState,
  type AccountAction,
  type AccountsView,
  type OAuthProfile,
  ProviderAuthState,
  type ProviderId,
  type SubscriptionAccountProvider,
  type SubscriptionQuotaReport,
} from "../api";
import { useAccountQuotaQuery, useAccountsQuery } from "../queries/global";
import { useAccountActionMutation } from "../queries/mutations/global";
import { koreanShortTime, timeUntil } from "../shared/local-time";
import { providerLabels } from "./providers";

export type QuotaStatus = SubscriptionQuotaReport["accounts"][number]["quota"];
export const QuotaStatus = Data.taggedEnum<QuotaStatus>();
type QuotaWindow = Data.TaggedEnum.Value<QuotaStatus, "observed">["windows"][number];
type QuotaUnavailableReason = Data.TaggedEnum.Value<QuotaStatus, "unavailable">["reason"];

/**
 * Anthropic names its windows; OpenAI reports `primary`/`secondary` with a length, which labels
 * them. A window with neither is shown by the name the provider sent.
 */
export const windowLabel = (window: Pick<QuotaWindow, "name" | "windowSeconds">) => {
  switch (window.name) {
    case "five_hour":
      return t({ message: "5시간", comment: "Name of the subscription's 5-hour usage window" });
    case "seven_day":
      return t({ message: "7일", comment: "Name of the subscription's 7-day usage window" });
    default: {
      if (window.windowSeconds === null) return window.name;
      const hours = Math.round(window.windowSeconds / 3600);
      const days = Math.round(hours / 24);
      return hours < 24
        ? t({ message: `${hours}시간`, comment: "Name of a usage window by its length in hours" })
        : t({ message: `${days}일`, comment: "Name of a usage window by its length in days" });
    }
  }
};

const quotaUnavailableReasons = {
  credential_expired: msg`구독 한도 조회 불가: 저장된 로그인이 만료돼 조회하지 않았습니다`,
  lookup_failed: msg`구독 한도 조회 실패: 공급자에게서 사용량을 받지 못했습니다`,
} satisfies Record<QuotaUnavailableReason, MessageDescriptor>;

/** Why a quota has no numbers; the app never estimates one. */
export function quotaUnavailableText(reason: QuotaUnavailableReason): string {
  return i18n._(quotaUnavailableReasons[reason]);
}

export const usedPercent = (window: QuotaWindow) => Math.min(100, Math.max(0, window.usedPercent));

export const gaugeTone = (used: number) =>
  used >= 90 ? "bg-destructive" : used >= 70 ? "bg-warning" : "bg-primary";

export const percentTone = (used: number) =>
  used >= 90 ? "text-destructive" : used >= 70 ? "text-warning" : undefined;

const providerIcons = { openai: codexIcon, anthropic: claudeIcon };

/** A text-sized provider icon: Codex for ChatGPT, Claude for Claude, a chip for a local endpoint. */
export function ProviderMark({ provider }: { provider: ProviderId }) {
  switch (provider) {
    case "openai":
    case "anthropic":
      return (
        <img
          src={providerIcons[provider]}
          alt=""
          aria-hidden="true"
          className="size-4 shrink-0 rounded-sm"
        />
      );
    case "openai-compatible":
      return <CpuIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
  }
}

/** One window as a labelled bar with its use and reset below; a stale value is dimmed. */
function QuotaGauge({
  window,
  stale,
  now,
}: {
  window: QuotaWindow;
  stale: boolean;
  now: DateTime.DateTime;
}) {
  const { t } = useLingui();
  const used = usedPercent(window);
  const percent = Math.round(used);
  const until =
    window.resetsAt !== null && window.resetsAt !== "" ? timeUntil(window.resetsAt, now) : null;
  return (
    <Meter.Root
      value={used}
      className="flex flex-col gap-1"
      getAriaValueText={() =>
        t({ message: `${percent}% 사용`, comment: "Share of the usage window used so far" })
      }
    >
      <Meter.Label className="text-xs">{windowLabel(window)}</Meter.Label>
      <Meter.Track className="h-1.5 overflow-hidden rounded-full bg-muted">
        <Meter.Indicator
          className={cn(
            "h-full rounded-full transition-all",
            gaugeTone(used),
            stale && "opacity-40",
          )}
        />
      </Meter.Track>
      <span className="flex justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
        <span>
          <Trans comment="Share of the usage window used so far">{percent}% 사용</Trans>
        </span>
        {until !== null && (
          <span>
            <Trans comment="When the usage window resets; until is the time left">
              {until} 후 초기화
            </Trans>
          </span>
        )}
      </span>
    </Meter.Root>
  );
}

/** The line under an account name: when its quota was read, or why it has none. */
const quotaMeta = (quota: QuotaStatus | undefined, failed: boolean) => {
  if (failed) return t`한도 상태를 확인하지 못했습니다`;
  if (quota === undefined)
    return t({ message: "한도 확인 중", comment: "Account card: the quota is still loading" });
  return QuotaStatus.$match(quota, {
    unavailable: ({ reason }) => quotaUnavailableText(reason),
    observed: ({ observedAt }) =>
      t({
        message: `${ph({ time: koreanShortTime(observedAt) })} 조회`,
        comment: "When the quota was read; time is a short local time",
      }),
    stale: ({ observedAt }) =>
      t({
        message: `최근 조회 실패 · ${ph({ time: koreanShortTime(observedAt) })} 기준 값`,
        comment: "The last quota read failed; the values shown were read at time",
      }),
  });
};

const rowLabel = (provider: ProviderId, label: string) =>
  `${label} (${i18n._(providerLabels[provider])})`;

function ProfileCard({
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
  const { t } = useLingui();
  const [renaming, setRenaming] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [label, setLabel] = useState(profile.label);
  const cancelRename = () => {
    setLabel(profile.label);
    setRenaming(false);
  };
  const windows =
    !quotaFailed && quota !== undefined && !QuotaStatus.$is("unavailable")(quota) ? quota : null;
  const now = DateTime.nowUnsafe();
  const accountName = profile.label;
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-lg border px-3 py-2.5",
        current && "border-primary/50",
      )}
      aria-label={rowLabel(provider, profile.label)}
    >
      {renaming ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim() === "") return;
            onAction({ intent: "rename", accountId: profile.id, label: label.trim() });
            setRenaming(false);
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
            onKeyDown={(event) => event.key === "Escape" && cancelRename()}
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
            onClick={cancelRename}
          >
            <XIcon />
          </Button>
        </form>
      ) : (
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium">{profile.label}</span>
              {current && (
                <Badge variant="outline">
                  <Trans comment="Badge on the account chats run on now">사용 중</Trans>
                </Badge>
              )}
            </span>
            <span className="truncate text-2xs text-muted-foreground">
              {quotaMeta(quota, quotaFailed)}
            </span>
          </div>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={t`${accountName} 이름 변경`}
            onClick={() => setRenaming(true)}
          >
            <PencilIcon /> <Trans comment="Button that renames the account">이름 변경</Trans>
          </Button>
          <AlertDialog open={confirmingLogout} onOpenChange={setConfirmingLogout}>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="sm"
                  aria-label={t`${accountName} 로그아웃`}
                  disabled={busy}
                />
              }
            >
              <LogOutIcon />{" "}
              <Trans comment="Button that signs the account out and removes it">로그아웃</Trans>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>{accountName} 계정에서 로그아웃할까요?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>이 앱의 계정 목록에서도 지웁니다.</Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans comment="Dialog button that cancels">취소</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    setConfirmingLogout(false);
                    onAction({ intent: "remove", accountId: profile.id });
                  }}
                >
                  <Trans comment="Dialog button that confirms signing the account out">
                    로그아웃
                  </Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
      {windows !== null && (
        <div className="flex flex-col gap-2.5">
          {windows.windows.map((window) => (
            <QuotaGauge
              key={window.name}
              window={window}
              stale={QuotaStatus.$is("stale")(windows)}
              now={now}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/** The provider's connection failure with its diagnostic fields folded away. */
function AuthErrorAlert({ auth }: { auth: Data.TaggedEnum.Value<ProviderAuthState, "error"> }) {
  return (
    <Alert variant="destructive" className="min-w-0">
      <AlertDescription className="min-w-0 wrap-break-word">
        {auth.message}
        {(auth.code || auth.httpStatus || auth.providerCode) && (
          <Collapsible className="mt-2 text-2xs">
            <CollapsibleTrigger className="group cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring flex items-center gap-1 text-left">
              <ChevronRightIcon
                aria-hidden="true"
                className="size-3 transition-transform group-data-[panel-open]:rotate-90"
              />
              <Trans comment="Toggle that shows the connection error's diagnostic fields">
                진단 정보
              </Trans>
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

/** A provider heading with its one action on the right. */
export function ProviderHeader({
  provider,
  description,
  children,
}: {
  provider: ProviderId;
  description: string;
  children: React.ReactNode;
}) {
  const { t } = useLingui();
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ProviderMark provider={provider} />
          {t(providerLabels[provider])}
        </h3>
        <p className="text-2xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** One subscription provider's accounts as the manager needs them. */
export type ProviderAccounts = {
  readonly provider: SubscriptionAccountProvider;
  readonly auth: ProviderAuthState | null;
  readonly view: AccountsView | undefined;
  readonly quota: SubscriptionQuotaReport | undefined;
  readonly quotaFailed: boolean;
  readonly busy: boolean;
};

function LoginStatus({
  group: { provider, view },
  onCancel,
}: {
  group: ProviderAccounts;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  if (view === undefined) return null;
  const providerName = t(providerLabels[provider]);
  return AccountLoginState.$match(view.login, {
    pending: ({ authorizationUrl }) => (
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
        <Spinner />
        <span className="min-w-0 flex-1">
          <Trans>브라우저에서 {providerName} 로그인을 완료해 주십시오</Trans>
        </span>
        <Button
          variant="ghost-muted"
          size="sm"
          onClick={() => window.open(authorizationUrl, "_blank", "noopener")}
        >
          <Trans comment="Button that opens the login page in the browser again">다시 열기</Trans>
        </Button>
        <Button variant="ghost-muted" size="sm" onClick={onCancel}>
          <Trans comment="Button that cancels the pending login">취소</Trans>
        </Button>
      </div>
    ),
    error: () => (
      <Alert variant="destructive">
        <AlertDescription>
          <Trans>새 계정 로그인을 완료하지 못했습니다. 다시 시도해 주십시오.</Trans>
        </AlertDescription>
      </Alert>
    ),
    idle: () => null,
    completed: () => null,
  });
}

function AddAccountForm({
  provider,
  busy,
  onAdd,
  onClose,
}: {
  provider: SubscriptionAccountProvider;
  busy: boolean;
  onAdd: (label: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [label, setLabel] = useState("");
  const providerName = t(providerLabels[provider]);
  return (
    <form
      aria-label={t({
        message: `새 ${providerName} 계정`,
        comment: "Label of the form that adds an account of the provider",
      })}
      className="flex items-center gap-1 rounded-lg border px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (label.trim() === "") return;
        onAdd(label.trim());
        onClose();
      }}
    >
      <Input
        aria-label={t({ message: "새 계정 이름", comment: "Field for the new account's name" })}
        placeholder={t`계정 이름 (예: 개인, 회사)`}
        value={label}
        maxLength={80}
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
        autoFocus
      />
      <Button type="submit" disabled={busy || label.trim() === ""}>
        <Trans comment="Button that adds the account by opening its login">로그인</Trans>
      </Button>
      <Button type="button" variant="outline" onClick={onClose}>
        <Trans comment="Button that closes the new account form">취소</Trans>
      </Button>
    </form>
  );
}

function ProviderAccountsSection({
  group,
  activeProvider,
  onAction,
}: {
  group: ProviderAccounts;
  activeProvider: ProviderId;
  onAction: (action: AccountAction) => void;
}) {
  const { t } = useLingui();
  const [adding, setAdding] = useState(false);
  const providerName = t(providerLabels[group.provider]);
  const profiles = group.view?.profiles ?? [];
  return (
    <section aria-label={providerName} className="flex flex-col gap-3 py-5 first:pt-0">
      <ProviderHeader
        provider={group.provider}
        description={t`계정마다 따로 로그인합니다. 쓸 계정은 사이드바 아래에서 고릅니다.`}
      >
        <Button
          variant="outline"
          size="sm"
          aria-label={t`${providerName} 계정 추가`}
          disabled={adding || group.busy}
          onClick={() => setAdding(true)}
        >
          <PlusIcon />{" "}
          <Trans comment="Button that adds an account of the provider">계정 추가</Trans>
        </Button>
      </ProviderHeader>
      {ProviderAuthState.$is("error")(group.auth) && <AuthErrorAlert auth={group.auth} />}
      {group.view === undefined ? (
        <Spinner />
      ) : profiles.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={t`${providerName} 계정 목록`}>
          {profiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              provider={group.provider}
              profile={profile}
              current={activeProvider === group.provider && profile.selected}
              quota={group.quota?.accounts.find((item) => item.accountId === profile.id)?.quota}
              quotaFailed={group.quotaFailed}
              busy={group.busy}
              onAction={onAction}
            />
          ))}
        </ul>
      ) : (
        !adding && (
          <p className="text-xs text-muted-foreground">
            <Trans>추가한 계정이 없습니다.</Trans>
          </p>
        )
      )}
      {adding && (
        <AddAccountForm
          provider={group.provider}
          busy={group.busy}
          onAdd={(name) => onAction({ intent: "add", label: name })}
          onClose={() => setAdding(false)}
        />
      )}
      <LoginStatus group={group} onCancel={() => onAction({ intent: "cancel" })} />
    </section>
  );
}

/**
 * Accounts grouped by provider, each group with its own add button: rename, log out and add here.
 * Switching belongs to the sidebar switcher, so this view only edits. `children` follows the
 * subscription groups, for the compatible endpoints.
 */
export function AccountManagerList({
  providers,
  activeProvider,
  error,
  onAction,
  children,
}: {
  providers: readonly ProviderAccounts[];
  activeProvider: ProviderId;
  error: string | null;
  onAction: (provider: SubscriptionAccountProvider, action: AccountAction) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col divide-y">
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {providers.map((group) => (
        <ProviderAccountsSection
          key={group.provider}
          group={group}
          activeProvider={activeProvider}
          onAction={(action) => onAction(group.provider, action)}
        />
      ))}
      {children}
    </div>
  );
}

const accountErrorMessage = (error: ApiError | null) => {
  if (error === null) return t`계정 작업에 실패했습니다.`;
  switch (error.code) {
    case "invalid_account_label":
    case "invalid_oauth_profile":
      return t`계정 이름은 1~80자로 입력해 주십시오.`;
    case "oauth_profile_in_use":
    case "oauth_profile_removing":
      return t`계정 작업을 완료하지 못했습니다. 이 계정의 실행이 끝난 뒤 다시 시도해 주십시오.`;
    case "oauth_profile_not_found":
      return t`계정을 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 시도해 주십시오.`;
    case "oauth_profile_missing_credential":
    case "oauth_profile_conflicting_credential":
    case "oauth_profile_copy_unverified":
      return t`저장된 로그인 정보를 확인하지 못했습니다. 계정을 다시 추가해 주십시오.`;
    case "login_in_progress":
      return t`이미 진행 중인 로그인이 있습니다. 그 로그인을 마치거나 취소한 뒤 다시 시도해 주십시오.`;
    case "account_login_failed":
      return t`로그인을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주십시오.`;
    case "account_store_unavailable":
      return t`계정 저장소를 열지 못했습니다. 잠시 뒤 다시 시도해 주십시오.`;
    default:
      return t`계정 작업에 실패했습니다.`;
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

/** Every subscription account, then `children`; mounted only while the sheet is open. */
export function AccountManager({
  auth,
  activeProvider,
  children,
}: {
  auth: Record<SubscriptionAccountProvider, ProviderAuthState | null>;
  activeProvider: ProviderId;
  children?: React.ReactNode;
}) {
  const { t } = useLingui();
  const openai = useProviderAccounts("openai", auth.openai);
  const anthropic = useProviderAccounts("anthropic", auth.anthropic);
  const [error, setError] = useState<string | null>(null);
  const runners = { openai: openai.run, anthropic: anthropic.run };
  return (
    <AccountManagerList
      providers={[openai.group, anthropic.group]}
      activeProvider={activeProvider}
      error={
        error ?? (openai.failed || anthropic.failed ? t`계정 목록을 불러오지 못했습니다.` : null)
      }
      onAction={(provider, next) => {
        setError(null);
        runners[provider](next).then(
          (view) => {
            if (next.intent === "add" && AccountLoginState.$is("pending")(view.login))
              window.open(view.login.authorizationUrl, "_blank", "noopener");
          },
          (failure) => setError(accountErrorMessage(isApiError(failure) ? failure : null)),
        );
      }}
    >
      {children}
    </AccountManagerList>
  );
}
