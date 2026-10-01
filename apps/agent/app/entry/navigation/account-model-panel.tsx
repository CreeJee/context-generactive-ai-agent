import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import type { ModelSelection, ProviderAuthState, ProviderId } from "../api";
import { SidebarDisclosureTrigger } from "./sidebar-disclosure-trigger";

const providerLabel = { openai: "ChatGPT", anthropic: "Claude" } satisfies Record<
  ProviderId,
  string
>;

export function accountSummary(
  provider: ProviderId,
  auth: ProviderAuthState | null,
  selection: ModelSelection | null,
  modelName: string | undefined,
) {
  const status = !auth
    ? "확인 중"
    : auth.status === "signed-in"
      ? "연결됨"
      : auth.status === "pending"
        ? "로그인 대기"
        : auth.status === "error"
          ? "연결 오류"
          : "로그인 필요";
  const model = selection
    ? `${providerLabel[selection.provider]} · ${modelName ?? selection.model}`
    : "모델 미선택";
  return { status, model, hasError: auth?.status === "error" };
}

/** Keep settings out of the default sidebar height while exposing the current selection. */
export function AccountModelPanel({
  provider,
  auth,
  selection,
  modelName,
  children,
}: {
  provider: ProviderId;
  auth: ProviderAuthState | null;
  selection: ModelSelection | null;
  modelName?: string;
  children: ReactNode;
}) {
  const { status, model, hasError } = accountSummary(provider, auth, selection, modelName);
  return (
    <Collapsible className="border-b">
      <SidebarDisclosureTrigger
        leading={
          hasError && (
            <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
          )
        }
        title={`${providerLabel[provider]} 계정과 모델 설정: ${status}, ${model}`}
      >
        {status === "연결됨" ? (
          <span className="font-medium">{model}</span>
        ) : (
          <>
            <span className="font-medium">
              {providerLabel[provider]} · {status}
            </span>
            <span className="text-muted-foreground"> · {model}</span>
          </>
        )}
      </SidebarDisclosureTrigger>
      <CollapsibleContent className="max-h-[min(55dvh,28rem)] overflow-y-auto border-t">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
