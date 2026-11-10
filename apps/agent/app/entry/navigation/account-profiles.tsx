import { Meter } from "@base-ui/react/meter";
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
import { problemText } from "../shared/copy-templates";
import { koreanShortTime, timeUntil } from "../shared/local-time";
import { navigationCopy } from "./copy";
import { providerLabels } from "./providers";

export type QuotaStatus = SubscriptionQuotaReport["accounts"][number]["quota"];
export const QuotaStatus = Data.taggedEnum<QuotaStatus>();
type QuotaWindow = Data.TaggedEnum.Value<QuotaStatus, "observed">["windows"][number];

/**
 * Anthropic names its windows; OpenAI reports `primary`/`secondary` with a length, which labels
 * them. A window with neither is shown by the name the provider sent.
 */
export const windowLabel = (window: Pick<QuotaWindow, "name" | "windowSeconds">) => {
  switch (window.name) {
    case "five_hour":
      return navigationCopy.quota.window.fiveHour;
    case "seven_day":
      return navigationCopy.quota.window.sevenDay;
    default: {
      if (window.windowSeconds === null) return window.name;
      const hours = Math.round(window.windowSeconds / 3600);
      return hours < 24
        ? navigationCopy.quota.window.hours(hours)
        : navigationCopy.quota.window.days(Math.round(hours / 24));
    }
  }
};

/** Why a quota has no numbers; the app never estimates one. */
export function quotaUnavailableText(
  reason: Data.TaggedEnum.Value<QuotaStatus, "unavailable">["reason"],
): string {
  return navigationCopy.quota.unavailable[reason];
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
  const used = usedPercent(window);
  const until =
    window.resetsAt !== null && window.resetsAt !== "" ? timeUntil(window.resetsAt, now) : null;
  return (
    <Meter.Root
      value={used}
      className="flex flex-col gap-1"
      getAriaValueText={() => navigationCopy.quota.used(Math.round(used))}
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
        <span>{navigationCopy.quota.used(Math.round(used))}</span>
        {until !== null && <span>{navigationCopy.quota.resetsIn(until)}</span>}
      </span>
    </Meter.Root>
  );
}

/** The line under an account name: when its quota was read, or why it has none. */
const quotaMeta = (quota: QuotaStatus | undefined, failed: boolean) => {
  if (failed) return navigationCopy.quota.failed;
  if (quota === undefined) return navigationCopy.quota.checking;
  return QuotaStatus.$match(quota, {
    unavailable: ({ reason }) => quotaUnavailableText(reason),
    observed: ({ observedAt }) => navigationCopy.quota.observed(koreanShortTime(observedAt)),
    stale: ({ observedAt }) => navigationCopy.quota.stale(koreanShortTime(observedAt)),
  });
};

const rowLabel = (provider: ProviderId, label: string) => `${label} (${providerLabels[provider]})`;

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
  const logoutConfirm = navigationCopy.profile.logoutConfirm(profile.label);
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
            aria-label={navigationCopy.rename.field}
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
            aria-label={navigationCopy.rename.save}
          >
            <CheckIcon />
          </Button>
          <Button
            type="button"
            variant="ghost-muted"
            size="icon"
            aria-label={navigationCopy.rename.cancel}
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
              {current && <Badge variant="outline">{navigationCopy.inUse}</Badge>}
            </span>
            <span className="truncate text-2xs text-muted-foreground">
              {quotaMeta(quota, quotaFailed)}
            </span>
          </div>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={navigationCopy.rename.openFor(profile.label)}
            onClick={() => setRenaming(true)}
          >
            <PencilIcon /> {navigationCopy.rename.open}
          </Button>
          <AlertDialog open={confirmingLogout} onOpenChange={setConfirmingLogout}>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="sm"
                  aria-label={navigationCopy.profile.logoutFor(profile.label)}
                  disabled={busy}
                />
              }
            >
              <LogOutIcon /> {navigationCopy.profile.logout}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{logoutConfirm.title}</AlertDialogTitle>
                <AlertDialogDescription>{logoutConfirm.body}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{logoutConfirm.choices.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    setConfirmingLogout(false);
                    onAction({ intent: "remove", accountId: profile.id });
                  }}
                >
                  {logoutConfirm.choices.logout}
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
              {navigationCopy.profile.diagnostics}
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
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ProviderMark provider={provider} />
          {providerLabels[provider]}
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
  if (view === undefined) return null;
  return AccountLoginState.$match(view.login, {
    pending: ({ authorizationUrl }) => (
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
        <Spinner />
        <span className="min-w-0 flex-1">
          {navigationCopy.login.pending(providerLabels[provider])}
        </span>
        <Button
          variant="ghost-muted"
          size="sm"
          onClick={() => window.open(authorizationUrl, "_blank", "noopener")}
        >
          {navigationCopy.login.reopen}
        </Button>
        <Button variant="ghost-muted" size="sm" onClick={onCancel}>
          {navigationCopy.login.cancel}
        </Button>
      </div>
    ),
    error: () => (
      <Alert variant="destructive">
        <AlertDescription>{problemText(navigationCopy.login.failed)}</AlertDescription>
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
  const [label, setLabel] = useState("");
  return (
    <form
      aria-label={navigationCopy.addAccount.form(providerLabels[provider])}
      className="flex items-center gap-1 rounded-lg border px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (label.trim() === "") return;
        onAdd(label.trim());
        onClose();
      }}
    >
      <Input
        aria-label={navigationCopy.addAccount.name}
        placeholder={navigationCopy.addAccount.placeholder}
        value={label}
        maxLength={80}
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
        autoFocus
      />
      <Button type="submit" disabled={busy || label.trim() === ""}>
        {navigationCopy.addAccount.submit}
      </Button>
      <Button type="button" variant="outline" onClick={onClose}>
        {navigationCopy.addAccount.cancel}
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
  const [adding, setAdding] = useState(false);
  const label = providerLabels[group.provider];
  const profiles = group.view?.profiles ?? [];
  return (
    <section aria-label={label} className="flex flex-col gap-3 py-5 first:pt-0">
      <ProviderHeader
        provider={group.provider}
        description={navigationCopy.subscriptionAccounts.description}
      >
        <Button
          variant="outline"
          size="sm"
          aria-label={navigationCopy.subscriptionAccounts.addFor(label)}
          disabled={adding || group.busy}
          onClick={() => setAdding(true)}
        >
          <PlusIcon /> {navigationCopy.subscriptionAccounts.add}
        </Button>
      </ProviderHeader>
      {ProviderAuthState.$is("error")(group.auth) && <AuthErrorAlert auth={group.auth} />}
      {group.view === undefined ? (
        <Spinner />
      ) : profiles.length > 0 ? (
        <ul
          className="flex flex-col gap-2"
          aria-label={navigationCopy.subscriptionAccounts.list(label)}
        >
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
            {navigationCopy.subscriptionAccounts.empty}
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
  const copy = navigationCopy.accountError;
  if (error === null) return copy.failed;
  switch (error.code) {
    case "invalid_account_label":
    case "invalid_oauth_profile":
      return copy.invalidLabel;
    case "oauth_profile_in_use":
    case "oauth_profile_removing":
      return problemText(copy.profileBusy);
    case "oauth_profile_not_found":
      return problemText(copy.profileNotFound);
    case "oauth_profile_missing_credential":
    case "oauth_profile_conflicting_credential":
    case "oauth_profile_copy_unverified":
      return problemText(copy.credentialUnreadable);
    case "login_in_progress":
      return problemText(copy.loginInProgress);
    case "account_login_failed":
      return problemText(copy.loginFailed);
    case "account_store_unavailable":
      return problemText(copy.storeUnavailable);
    default:
      return copy.failed;
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
  const openai = useProviderAccounts("openai", auth.openai);
  const anthropic = useProviderAccounts("anthropic", auth.anthropic);
  const [error, setError] = useState<string | null>(null);
  const runners = { openai: openai.run, anthropic: anthropic.run };
  return (
    <AccountManagerList
      providers={[openai.group, anthropic.group]}
      activeProvider={activeProvider}
      error={
        error ??
        (openai.failed || anthropic.failed ? navigationCopy.subscriptionAccounts.listFailed : null)
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
