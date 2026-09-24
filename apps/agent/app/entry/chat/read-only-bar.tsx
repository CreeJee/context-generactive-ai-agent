import { EyeIcon } from "lucide-react";
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
  onContinue: () => void;
}) {
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
              {lease.state === "other"
                ? "다른 창에서 이 대화를 쓰고 있어요"
                : "다른 창이 이 대화를 더 이상 쓰지 않아요"}
            </ItemTitle>
            <ItemDescription>
              {refused && lease.state === "other"
                ? "아직 쓰고 있어서 이어갈 수 없어요. 그 창을 닫거나 다른 대화로 옮기면 이어갈 수 있어요."
                : "여기서는 읽기만 할 수 있어요."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              size="sm"
              variant={lease.state === "free" ? "default" : "outline"}
              onClick={onContinue}
            >
              이어서 작업
            </Button>
          </ItemActions>
        </Item>
      );
  }
}
