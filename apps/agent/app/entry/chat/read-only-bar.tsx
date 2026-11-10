import { Trans } from "@lingui/react/macro";
import { EyeIcon } from "lucide-react";
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

/**
 * Takes the composer's place on a page that may only read the session: why, and a way to continue
 * here. Continuing asks the server again, so a page never takes over while another one still uses
 * the session.
 */
export function ReadOnlyBar({
  lease,
  refused,
  onContinue,
}: {
  lease: PageLease;
  refused: boolean;
  onContinue: () => void | Promise<void>;
}) {
  const [connectionFailed, setConnectionFailed] = useState(false);
  const continueHere = () => {
    setConnectionFailed(false);
    return Promise.resolve()
      .then(onContinue)
      .catch(() => setConnectionFailed(true));
  };
  switch (lease.state) {
    case "checking":
    case "mine":
      return null;
    case "other":
    case "free":
      return (
        <Item variant="card">
          <ItemMedia variant="icon">
            <EyeIcon className="text-muted-foreground" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>
              {lease.state === "other" ? (
                <Trans>다른 창에서 이 대화를 쓰고 있습니다</Trans>
              ) : (
                <Trans>다른 창이 이 대화를 더 이상 쓰지 않습니다</Trans>
              )}
            </ItemTitle>
            <ItemDescription>
              {connectionFailed ? (
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
              variant={lease.state === "free" ? "default" : "outline"}
              onClick={continueHere}
            >
              <Trans comment="Button that takes over the conversation in this window">
                이어서 작업
              </Trans>
            </Button>
          </ItemActions>
        </Item>
      );
  }
}
