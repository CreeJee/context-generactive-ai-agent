import { Meter } from "@base-ui/react/meter";
import { cn } from "cn";
import { CheckIcon, ChevronsUpDownIcon, PlugIcon, UsersIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type {
  OAuthProfile,
  ProviderAuthState,
  ProviderId,
  SubscriptionAccountProvider,
  SubscriptionQuotaReport,
} from "../api";
import { Spinner } from "~/components/ui/spinner";
import { useAccountQuotaQuery, useAccountsQuery } from "../queries/global";
import type { AccountTarget } from "../queries/mutations/global";
import { gaugeTone, windowLabel } from "./account-profiles";
import { providerLabels } from "./providers";

type QuotaStatus = SubscriptionQuotaReport["accounts"][number]["quota"];

/** One row of the switcher: a subscription login, or the single compatible configuration. */
export type AccountEntry =
  | {
      readonly kind: "profile";
      readonly provider: SubscriptionAccountProvider;
      readonly profile: OAuthProfile;
      readonly quota: QuotaStatus | undefined;
      readonly current: boolean;
    }
  | { readonly kind: "compatible"; readonly configured: boolean; readonly current: boolean };

const entryKey = (entry: AccountEntry) => {
  switch (entry.kind) {
    case "profile":
      return entry.profile.id;
    case "compatible":
      return "openai-compatible";
  }
};

const entryProvider = (entry: AccountEntry): ProviderId => {
  switch (entry.kind) {
    case "profile":
      return entry.provider;
    case "compatible":
      return "openai-compatible";
  }
};

const entryLabel = (entry: AccountEntry) => {
  switch (entry.kind) {
    case "profile":
      return entry.profile.label;
    case "compatible":
      return "직접 설정한 엔드포인트";
  }
};

/** First letters collide (ChatGPT, Claude), so each provider has its own mark. */
const providerMark = (provider: SubscriptionAccountProvider) => {
  switch (provider) {
    case "openai":
      return "G";
    case "anthropic":
      return "A";
  }
};

function ProviderMark({ provider }: { provider: ProviderId }) {
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

/** Per-window bars on their own line, so a narrow sidebar shrinks the bars instead of wrapping text. */
function QuotaBars({ quota }: { quota: QuotaStatus | undefined }) {
  if (quota === undefined) return null;
  switch (quota.status) {
    case "unavailable":
      return null;
    case "observed":
    case "stale":
      return (
        <span className="flex w-full min-w-0 items-center gap-3">
          {quota.windows.map((window) => {
            const used = Math.min(100, Math.max(0, window.usedPercent));
            return (
              <Meter.Root
                key={window.name}
                value={used}
                className="flex min-w-0 flex-1 items-center gap-1 whitespace-nowrap"
                getAriaValueText={() => `${Math.round(used)}% 사용`}
              >
                <Meter.Label className="shrink-0 text-2xs text-muted-foreground">
                  {windowLabel(window.name)}
                </Meter.Label>
                <Meter.Track className="h-1 min-w-4 flex-1 overflow-hidden rounded-full bg-muted">
                  <Meter.Indicator
                    className={cn(
                      "h-full rounded-full",
                      gaugeTone(used),
                      quota.status === "stale" && "opacity-40",
                    )}
                  />
                </Meter.Track>
                <span className="shrink-0 text-2xs tabular-nums">{Math.round(used)}%</span>
              </Meter.Root>
            );
          })}
        </span>
      );
  }
}

/** The short status next to the provider name; numbers live in `QuotaBars`. */
const entryNote = (entry: AccountEntry): string | null => {
  switch (entry.kind) {
    case "compatible":
      return entry.configured ? "설정됨" : "설정 필요";
    case "profile":
      switch (entry.quota?.status) {
        case undefined:
        case "observed":
          return null;
        case "stale":
          return "최근 조회 실패";
        case "unavailable":
          return "한도 조회 불가";
      }
  }
};

function EntrySummary({ entry }: { entry: AccountEntry }) {
  const note = entryNote(entry);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
      <span className="truncate text-xs font-medium">{entryLabel(entry)}</span>
      <span className="truncate text-2xs text-muted-foreground">
        {providerLabels[entryProvider(entry)]}
        {note !== null && ` · ${note}`}
      </span>
      {entry.kind === "profile" && <QuotaBars quota={entry.quota} />}
    </span>
  );
}

/** The account in use at the bottom of the sidebar; opening it lists every account to switch to. */
export function AccountSwitcherMenu({
  entries,
  busy,
  error,
  onSwitch,
  onConfigureCompatible,
  onManage,
}: {
  entries: readonly AccountEntry[];
  busy: boolean;
  error: string | null;
  onSwitch: (target: AccountTarget) => void;
  onConfigureCompatible: () => void;
  onManage: () => void;
}) {
  const current = entries.find((entry) => entry.current);
  return (
    <div className="flex flex-col gap-1 border-t p-2">
      {error && <p className="px-1 text-2xs text-destructive">{error}</p>}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-busy={busy}
          aria-label={
            current !== undefined
              ? `계정 전환: ${entryLabel(current)} (${providerLabels[entryProvider(current)]})`
              : "계정 전환"
          }
          render={
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30 data-popup-open:bg-accent"
            />
          }
        >
          {current !== undefined ? (
            <>
              <ProviderMark provider={entryProvider(current)} />
              <EntrySummary entry={current} />
            </>
          ) : (
            <>
              <ProviderMark provider="openai-compatible" />
              <span className="flex-1 text-left text-xs text-muted-foreground">
                연결된 계정이 없어요
              </span>
            </>
          )}
          {busy ? (
            <Spinner className="size-3.5 shrink-0" />
          ) : (
            <ChevronsUpDownIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>계정 전환</DropdownMenuLabel>
            {entries.map((entry) => (
              <DropdownMenuItem
                key={entryKey(entry)}
                aria-label={`${entryLabel(entry)} (${providerLabels[entryProvider(entry)]})`}
                onClick={() => {
                  if (entry.current) return;
                  switch (entry.kind) {
                    case "profile":
                      return onSwitch({ provider: entry.provider, accountId: entry.profile.id });
                    case "compatible":
                      return entry.configured
                        ? onSwitch({ provider: "openai-compatible" })
                        : onConfigureCompatible();
                  }
                }}
              >
                <ProviderMark provider={entryProvider(entry)} />
                <EntrySummary entry={entry} />
                <CheckIcon
                  aria-hidden="true"
                  className={cn("shrink-0", !entry.current && "invisible")}
                />
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onManage}>
            <UsersIcon /> 계정 추가·관리
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Loads every provider's accounts for the switcher; the account in use follows the model selection. */
export function AccountSwitcher({
  activeProvider,
  compatibleAuth,
  busy,
  error,
  onSwitch,
  onConfigureCompatible,
  onManage,
}: {
  activeProvider: ProviderId;
  compatibleAuth: ProviderAuthState | null;
  busy: boolean;
  error: string | null;
  onSwitch: (target: AccountTarget) => void;
  onConfigureCompatible: () => void;
  onManage: () => void;
}) {
  const openai = useAccountsQuery("openai", true);
  const anthropic = useAccountsQuery("anthropic", true);
  const openaiQuota = useAccountQuotaQuery("openai", true);
  const anthropicQuota = useAccountQuotaQuery("anthropic", true);
  const profiles = (
    provider: SubscriptionAccountProvider,
    profiles: readonly OAuthProfile[] | undefined,
    quota: SubscriptionQuotaReport | undefined,
  ): AccountEntry[] =>
    (profiles ?? []).map((profile) => ({
      kind: "profile",
      provider,
      profile,
      quota: quota?.accounts.find((account) => account.accountId === profile.id)?.quota,
      current: activeProvider === provider && profile.selected,
    }));
  const entries: AccountEntry[] = [
    ...profiles("openai", openai.data?.profiles, openaiQuota.data),
    ...profiles("anthropic", anthropic.data?.profiles, anthropicQuota.data),
    {
      kind: "compatible",
      configured: compatibleAuth?.status === "signed-in",
      current: activeProvider === "openai-compatible",
    },
  ];
  return (
    <AccountSwitcherMenu
      entries={entries}
      busy={busy}
      error={error}
      onSwitch={onSwitch}
      onConfigureCompatible={onConfigureCompatible}
      onManage={onManage}
    />
  );
}
