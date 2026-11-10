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
import { problemText } from "../shared/copy-templates";
import { chatCopy } from "./copy";

const copy = chatCopy.readOnlyBar;

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
              {lease.state === "other" ? copy.inUseElsewhere : copy.releasedElsewhere}
            </ItemTitle>
            <ItemDescription>
              {connectionFailed
                ? problemText(copy.connectionFailed)
                : refused && lease.state === "other"
                  ? copy.stillInUse
                  : copy.readOnly}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              size="sm"
              variant={lease.state === "free" ? "default" : "outline"}
              onClick={continueHere}
            >
              {copy.continueHere}
            </Button>
          </ItemActions>
        </Item>
      );
  }
}
