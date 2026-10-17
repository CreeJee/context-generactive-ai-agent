import { cn } from "cn";
import { DateTime } from "effect";
import { CheckIcon, ChevronsUpDownIcon, Settings2Icon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type {
  OAuthProfile,
  ProviderId,
  SubscriptionAccountProvider,
  SubscriptionQuotaReport,
} from "../api";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  useAccountQuotaQuery,
  useAccountsQuery,
  useCompatibleAccountsQuery,
} from "../queries/global";
import type { CompatibleAccountStatus } from "./compatible-client";
import type { AccountTarget } from "../queries/mutations/global";
import {
  percentTone,
  ProviderMark,
  usedPercent,
  windowLabel,
  type QuotaStatus,
} from "./account-profiles";
import { timeUntil } from "../shared/local-time";
import { providerLabels } from "./providers";

/** One row of the switcher: a subscription login, or a compatible endpoint. */
export type AccountEntry =
  | {
      readonly kind: "profile";
      readonly provider: SubscriptionAccountProvider;
      readonly profile: OAuthProfile;
      readonly quota: QuotaStatus | undefined;
      readonly current: boolean;
    }
  | {
      readonly kind: "compatible";
      readonly account: CompatibleAccountStatus;
      readonly current: boolean;
    };

const entryKey = (entry: AccountEntry) => {
  switch (entry.kind) {
    case "profile":
      return entry.profile.id;
    case "compatible":
      return `openai-compatible:${entry.account.id}`;
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
      return entry.account.label;
  }
};

/** Provider type and the user's name for the account, read together on one line. */
function AccountName({ entry }: { entry: AccountEntry }) {
  return (
    <span className="min-w-0 flex-1 truncate text-left text-xs">
      <span className="text-muted-foreground">{providerLabels[entryProvider(entry)]} · </span>
      <span className="font-medium">{entryLabel(entry)}</span>
    </span>
  );
}

/**
 * The tightest window only, as time to reset and percent used, like a status bar; every window
 * stays in the tooltip and in the account manager.
 */
function QuotaHeadline({ entry }: { entry: AccountEntry }) {
  switch (entry.kind) {
    case "compatible":
      return (
        <span className="shrink-0 text-2xs text-muted-foreground">
          {entry.account.models.length > 0 ? `모델 ${entry.account.models.length}개` : "모델 없음"}
        </span>
      );
    case "profile": {
      const { quota } = entry;
      switch (quota?.status) {
        case undefined:
          return null;
        case "unavailable":
          return <span className="shrink-0 text-2xs text-muted-foreground">조회 불가</span>;
        case "observed":
        case "stale": {
          const tightest = quota.windows.reduce<(typeof quota.windows)[number] | undefined>(
            (worst, window) =>
              worst === undefined || usedPercent(window) > usedPercent(worst) ? window : worst,
            undefined,
          );
          if (tightest === undefined) return null;
          const used = Math.round(usedPercent(tightest));
          const until =
            tightest.resetsAt !== null && tightest.resetsAt !== ""
              ? timeUntil(tightest.resetsAt, DateTime.nowUnsafe())
              : null;
          return (
            <span
              className={cn(
                "flex shrink-0 items-baseline gap-1.5 tabular-nums",
                quota.status === "stale" && "opacity-50",
              )}
              title={quota.windows
                .map((window) => `${windowLabel(window)} ${Math.round(usedPercent(window))}%`)
                .join(" · ")}
            >
              {until !== null && <span className="text-2xs text-muted-foreground">{until}</span>}
              <span className={cn("text-xs font-medium", percentTone(used))}>{used}%</span>
            </span>
          );
        }
      }
    }
  }
}

function EntryRow({ entry }: { entry: AccountEntry }) {
  return (
    <>
      <ProviderMark provider={entryProvider(entry)} />
      <AccountName entry={entry} />
      <QuotaHeadline entry={entry} />
    </>
  );
}

/** The account in use at the bottom of the sidebar; opening it lists every account to switch to. */
export function AccountSwitcherMenu({
  entries,
  busy,
  error,
  onSwitch,
  onManage,
}: {
  entries: readonly AccountEntry[];
  busy: boolean;
  error: string | null;
  onSwitch: (target: AccountTarget) => void;
  onManage: () => void;
}) {
  const current = entries.find((entry) => entry.current);
  return (
    <div className="flex flex-col gap-1 border-t p-2">
      {error && <p className="px-1 text-2xs text-destructive">{error}</p>}
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            aria-busy={busy}
            aria-label={
              current !== undefined
                ? `계정 전환: ${entryLabel(current)} (${providerLabels[entryProvider(current)]})`
                : "계정 전환"
            }
            render={
              <button
                type="button"
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30 data-popup-open:bg-accent"
              />
            }
          >
            {current !== undefined ? (
              <EntryRow entry={current} />
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
          <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>계정 전환</DropdownMenuLabel>
              {entries.map((entry) => (
                <DropdownMenuItem
                  key={entryKey(entry)}
                  disabled={busy}
                  aria-label={`${entryLabel(entry)} (${providerLabels[entryProvider(entry)]})`}
                  onClick={() => {
                    if (entry.current) return;
                    switch (entry.kind) {
                      case "profile":
                        return onSwitch({ provider: entry.provider, accountId: entry.profile.id });
                      case "compatible":
                        return onSwitch({
                          provider: "openai-compatible",
                          accountId: entry.account.id,
                        });
                    }
                  }}
                >
                  <EntryRow entry={entry} />
                  <CheckIcon
                    aria-hidden="true"
                    className={cn("shrink-0", !entry.current && "invisible")}
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost-muted"
          size="icon-lg"
          aria-label="계정 관리"
          title="계정 추가·수정·로그아웃"
          onClick={onManage}
        >
          <Settings2Icon />
        </Button>
      </div>
    </div>
  );
}

/** Loads every provider's accounts for the switcher; the account in use follows the model selection. */
export function AccountSwitcher({
  activeProvider,
  busy,
  error,
  onSwitch,
  onManage,
}: {
  activeProvider: ProviderId;
  busy: boolean;
  error: string | null;
  onSwitch: (target: AccountTarget) => void;
  onManage: () => void;
}) {
  const openai = useAccountsQuery("openai", true);
  const anthropic = useAccountsQuery("anthropic", true);
  const openaiQuota = useAccountQuotaQuery("openai", true);
  const anthropicQuota = useAccountQuotaQuery("anthropic", true);
  const compatible = useCompatibleAccountsQuery();
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
    ...(compatible.data?.accounts ?? []).map((account): AccountEntry => ({
      kind: "compatible",
      account,
      current: activeProvider === "openai-compatible" && account.selected,
    })),
  ];
  return (
    <AccountSwitcherMenu
      entries={entries}
      busy={busy}
      error={error}
      onSwitch={onSwitch}
      onManage={onManage}
    />
  );
}
