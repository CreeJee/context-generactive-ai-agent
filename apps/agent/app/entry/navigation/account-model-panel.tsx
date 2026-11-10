import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Function as EffectFunction } from "effect";
import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { ProviderAuthState, type ModelSelection, type ProviderId } from "../api";
import { SidebarDisclosureTrigger } from "./sidebar-disclosure-trigger";

import { providerLabels as providerLabel } from "./providers";

export const accountSummary: {
  (
    auth: ProviderAuthState | null,
    selection: ModelSelection | null,
    modelName: string | undefined,
  ): (provider: ProviderId) => ReturnType<typeof accountSummaryBody>;
} & typeof accountSummaryBody = EffectFunction.dual(4, accountSummaryBody);
function accountSummaryBody(
  provider: ProviderId,
  auth: ProviderAuthState | null,
  selection: ModelSelection | null,
  modelName: string | undefined,
) {
  const status = !(auth !== null)
    ? t({ message: "확인 중", comment: "Account connection status: still being checked" })
    : ProviderAuthState.$match(auth, {
        "signed-in": () => t({ message: "연결됨", comment: "Account connection status" }),
        pending: () =>
          t({
            message: "로그인 대기",
            comment: "Account connection status: waiting for the browser login to finish",
          }),
        error: () =>
          t({ message: "연결 오류", comment: "Account connection status: the connection failed" }),
        "signed-out": () =>
          provider === "openai-compatible"
            ? t({
                message: "설정 필요",
                comment: "Account connection status: no compatible endpoint is set up yet",
              })
            : t({ message: "로그인 필요", comment: "Account connection status: signed out" }),
      });
  const model =
    selection !== null
      ? `${i18n._(providerLabel[selection.provider])} / ${modelName ?? selection.model}`
      : t({ message: "모델 미선택", comment: "Sidebar account summary when no model is chosen" });
  return { status, model, hasError: ProviderAuthState.$is("error")(auth) };
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
  const { t } = useLingui();
  const { status, model, hasError } = accountSummary(provider, auth, selection, modelName);
  const providerName = t(providerLabel[provider]);
  return (
    <Collapsible className="border-b">
      <SidebarDisclosureTrigger
        leading={
          hasError && (
            <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
          )
        }
        title={t({
          message: `${providerName} 계정과 모델 설정: ${status}, ${model}`,
          comment: "Tooltip of the sidebar account panel; model reads as provider / model name",
        })}
      >
        {ProviderAuthState.$is("signed-in")(auth) ? (
          <span className="font-medium">{model}</span>
        ) : (
          <>
            <span className="font-medium">
              {providerName} · {status}
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
