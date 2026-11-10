import { Function as EffectFunction } from "effect";
import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { ProviderAuthState, type ModelSelection, type ProviderId } from "../api";
import { navigationCopy } from "./copy";
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
  const copy = navigationCopy.accountModel.status;
  const status = !(auth !== null)
    ? copy.checking
    : ProviderAuthState.$match(auth, {
        "signed-in": () => copy.signedIn,
        pending: () => copy.pending,
        error: () => copy.error,
        "signed-out": () =>
          provider === "openai-compatible" ? copy.setupNeeded : copy.loginNeeded,
      });
  const model =
    selection !== null
      ? `${providerLabel[selection.provider]} / ${modelName ?? selection.model}`
      : navigationCopy.accountModel.noModel;
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
  const { status, model, hasError } = accountSummary(provider, auth, selection, modelName);
  return (
    <Collapsible className="border-b">
      <SidebarDisclosureTrigger
        leading={
          hasError && (
            <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
          )
        }
        title={navigationCopy.accountModel.trigger(providerLabel[provider], status, model)}
      >
        {status === navigationCopy.accountModel.status.signedIn ? (
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
