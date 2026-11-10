import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { EyeIcon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "~/components/ui/item";
import type { PageLease } from "../session/session-lease";

/** A lease the page cannot write under, where the bar takes the composer's place. */
type Blocked = Extract<PageLease, { readonly state: "other" | "free" | "unreachable" }>;

/** Whether the bar takes the composer's place: the page knows it may not write, or cannot ask. */
export const isBlocked = (lease: PageLease): lease is Blocked =>
  lease.state === "other" || lease.state === "free" || lease.state === "unreachable";

const titles = {
  other: msg`다른 창에서 이 대화를 쓰고 있습니다`,
  free: msg`다른 창이 이 대화를 더 이상 쓰지 않습니다`,
  unreachable: msg`이 대화를 쓸 수 있는지 확인하지 못했습니다`,
} satisfies Record<Blocked["state"], MessageDescriptor>;

/**
 * Takes the composer's place on a page that may only read the session, or could not ask the server
 * whether it may write: why, and a way to continue here. Continuing asks the server again, so a page
 * never takes over while another one still uses the session.
 */
export function ReadOnlyBar({
  lease,
  refused,
  onContinue,
}: {
  lease: Blocked;
  refused: boolean;
  onContinue: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const [connectionFailed, setConnectionFailed] = useState(false);
  const continueHere = () => {
    setConnectionFailed(false);
    return Promise.resolve()
      .then(onContinue)
      .catch(() => setConnectionFailed(true));
  };
  const unreachable = lease.state === "unreachable";
  return (
    <Item variant="card">
      <ItemMedia variant="icon">
        {unreachable ? (
          <UnplugIcon className="text-muted-foreground" />
        ) : (
          <EyeIcon className="text-muted-foreground" />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t(titles[lease.state])}</ItemTitle>
        <ItemDescription>
          {connectionFailed || unreachable ? (
            <Trans>연결하지 못했습니다. 다시 시도해 주십시오.</Trans>
          ) : refused && lease.state === "other" ? (
            <Trans>
              아직 쓰고 있어서 이어갈 수 없습니다. 그 창을 닫거나 다른 대화로 옮기면 이어갈 수
              있습니다.
            </Trans>
          ) : (
            <Trans>여기서는 읽기만 할 수 있습니다.</Trans>
          )}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          size="sm"
          variant={lease.state === "other" ? "outline" : "default"}
          onClick={continueHere}
        >
          {unreachable ? (
            <Trans comment="Button that asks the server again whether this window may write">
              다시 시도
            </Trans>
          ) : (
            <Trans comment="Button that takes over the conversation in this window">
              이어서 작업
            </Trans>
          )}
        </Button>
      </ItemActions>
    </Item>
  );
}
