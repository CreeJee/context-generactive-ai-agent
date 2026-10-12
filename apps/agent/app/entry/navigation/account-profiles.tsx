import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import {
  ApiError,
  type AccountAction,
  type AccountsView,
  type OAuthProfile,
  type SubscriptionAccountProvider,
  type SubscriptionQuotaReport,
} from "../api";
import { useAccountQuotaQuery, useAccountsQuery } from "../queries/global";
import { useAccountActionMutation } from "../queries/mutations/global";

type QuotaStatus = SubscriptionQuotaReport["accounts"][number]["quota"];
type QuotaWindow = Extract<QuotaStatus, { status: "observed" }>["windows"][number];

const windowText = (window: QuotaWindow) =>
  `${window.name} ${Math.round(window.usedPercent)}% 사용${window.resetsAt ? ` · ${new Date(window.resetsAt).toLocaleString("ko-KR")} 초기화` : ""}`;

/** Provider-reported numbers only; an unavailable quota says why instead of estimating one. */
export function quotaText(quota: QuotaStatus): string {
  switch (quota.status) {
    case "observed":
      return `${quota.windows.map(windowText).join(", ")} (${new Date(quota.observedAt).toLocaleString("ko-KR")} 조회)`;
    case "stale":
      return `${quota.windows.map(windowText).join(", ")} (오래된 값: ${new Date(quota.observedAt).toLocaleString("ko-KR")} 기준, 최근 조회 실패)`;
    case "unavailable":
      switch (quota.reason) {
        case "no_permitted_route":
          return "구독 한도 조회 불가: 허용된 조회 경로가 확인되지 않았어요";
        case "provider_policy_restricted":
          return "구독 한도 조회 불가: 공급자 정책상 이 앱에서 조회하지 않아요";
      }
  }
}

function QuotaLine({
  quota,
  failed,
}: {
  quota: QuotaStatus | undefined;
  /** The status request itself failed, which is not the same as an unavailable quota. */
  failed: boolean;
}) {
  if (failed)
    return <p className="text-2xs text-muted-foreground">한도 상태를 확인하지 못했어요</p>;
  if (!quota) return <p className="text-2xs text-muted-foreground">한도 확인 중</p>;
  return <p className="text-2xs text-muted-foreground">{quotaText(quota)}</p>;
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
    <li className="flex flex-col gap-1 rounded-md border px-2 py-1.5" aria-label={profile.label}>
      {renaming ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!label.trim()) return;
            onAction({ intent: "rename", accountId: profile.id, label: label.trim() });
            setRenaming(false);
          }}
        >
          <Input
            aria-label="계정 이름"
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
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
            disabled={busy}
            aria-label={`${profile.label} 계정 해제`}
            title="계정 해제"
            onClick={() => {
              if (window.confirm(`${profile.label} 계정을 이 앱에서 해제할까요?`))
                onAction({ intent: "remove", accountId: profile.id });
            }}
          >
            <Trash2Icon />
          </Button>
        </div>
      )}
      <QuotaLine quota={quota} failed={quotaFailed} />
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
  const [label, setLabel] = useState("");
  if (!view) return <Spinner />;
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
      ) : (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!label.trim()) return;
            onAction({ intent: "add", label: label.trim() });
            setLabel("");
          }}
        >
          <Input
            aria-label="새 계정 이름"
            placeholder="새 계정 이름"
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button type="submit" variant="outline" size="xs" disabled={busy || !label.trim()}>
            <PlusIcon /> 추가
          </Button>
        </form>
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
  if (!(error instanceof ApiError)) return "계정 작업에 실패했어요.";
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
