import { Meter } from "@base-ui/react/meter";
import { cn } from "cn";
import { CheckIcon, EllipsisIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import {
  isApiError,
  type AccountAction,
  type AccountsView,
  type OAuthProfile,
  type SubscriptionAccountProvider,
  type SubscriptionQuotaReport,
} from "../api";
import { useAccountQuotaQuery, useAccountsQuery } from "../queries/global";
import { useAccountActionMutation } from "../queries/mutations/global";
import { koreanShortTime } from "../shared/local-time";

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

function ProfileRow({
  profile,
  quota,
  quotaFailed,
  busy,
  onAction,
}: {
  profile: OAuthProfile;
  quota: QuotaStatus | undefined;
  quotaFailed: boolean;
  busy: boolean;
  onAction: (action: AccountAction) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(profile.label);
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-md border px-2 py-1.5",
        profile.selected && "border-primary/50 bg-primary/5",
      )}
      aria-label={profile.label}
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
            aria-label="계정 이름"
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setLabel(profile.label);
              setRenaming(false);
            }}
            autoFocus
          />
          <Button type="submit" variant="ghost" size="icon-xs" aria-label="이름 저장">
            <CheckIcon />
          </Button>
        </form>
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{profile.label}</span>
          {profile.selected ? (
            <Badge variant="secondary">사용 중</Badge>
          ) : (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => onAction({ intent: "select", accountId: profile.id })}
            >
              전환
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" aria-label={`${profile.label} 계정 관리`} />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <PencilIcon /> 이름 변경
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`${profile.label} 계정을 이 앱에서 해제할까요?`))
                    onAction({ intent: "remove", accountId: profile.id });
                }}
              >
                <Trash2Icon /> 계정 해제
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <QuotaGauges quota={quota} failed={quotaFailed} />
    </li>
  );
}

/** Local OAuth accounts of one provider with their subscription quota status. */
export function AccountProfiles({
  view,
  quota,
  quotaFailed,
  error,
  busy,
  onAction,
}: {
  view: AccountsView | undefined;
  quota: SubscriptionQuotaReport | undefined;
  quotaFailed: boolean;
  error: string | null;
  busy: boolean;
  onAction: (action: AccountAction) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  if (view === undefined) return <Spinner />;
  const quotaOf = (id: string) => quota?.accounts.find((account) => account.accountId === id);
  return (
    <div className="flex flex-col gap-2">
      {view.profiles.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="계정 목록">
          {view.profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              quota={quotaOf(profile.id)?.quota}
              quotaFailed={quotaFailed}
              busy={busy}
              onAction={onAction}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">추가한 계정이 없어요.</p>
      )}
      {view.login.status === "pending" ? (
        <div className="flex flex-col gap-1.5 text-xs">
          <span className="flex items-center gap-2">
            <Spinner /> 브라우저에서 새 계정 로그인을 완료하세요
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(view.login.authorizationUrl, "_blank", "noopener")}
            >
              로그인 창 다시 열기
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction({ intent: "cancel" })}>
              취소
            </Button>
          </div>
        </div>
      ) : adding ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim() === "") return;
            onAction({ intent: "add", label: label.trim() });
            setLabel("");
            setAdding(false);
          }}
        >
          <Input
            aria-label="새 계정 이름"
            placeholder="새 계정 이름"
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
            autoFocus
          />
          <Button type="submit" variant="outline" size="xs" disabled={busy || label.trim() === ""}>
            로그인
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="계정 추가 취소"
            onClick={() => {
              setLabel("");
              setAdding(false);
            }}
          >
            <XIcon />
          </Button>
        </form>
      ) : (
        <Button
          variant="ghost-muted"
          size="xs"
          className="self-start"
          disabled={busy}
          onClick={() => setAdding(true)}
        >
          <PlusIcon /> 계정 추가
        </Button>
      )}
      {view.login.status === "error" && (
        <Alert variant="destructive">
          <AlertDescription>새 계정 로그인을 완료하지 못했어요. 다시 시도하세요.</AlertDescription>
        </Alert>
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

/** Loads and changes one subscription provider's accounts; mounted only while expanded. */
export function SubscriptionAccounts({ provider }: { provider: SubscriptionAccountProvider }) {
  const accounts = useAccountsQuery(provider, true);
  const quota = useAccountQuotaQuery(provider, true);
  const action = useAccountActionMutation(provider);
  const [error, setError] = useState<string | null>(null);
  const profileCount = accounts.data?.profiles.length;
  const refetchQuota = quota.refetch;
  // A login finished in another tab adds a profile whose quota row is not loaded yet.
  useEffect(() => {
    if (profileCount !== undefined) void refetchQuota();
  }, [profileCount, refetchQuota]);
  return (
    <AccountProfiles
      view={accounts.data}
      quota={quota.data}
      quotaFailed={quota.isError}
      error={error ?? (accounts.isError ? "계정 목록을 불러오지 못했어요." : null)}
      busy={action.isPending}
      onAction={(next) => {
        setError(null);
        action.mutateAsync(next).then(
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
