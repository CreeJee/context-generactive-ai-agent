import { EyeIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import type { PageLease } from "./session-lease";

/**
 * Shown on a page that may only read the session: why, and a way to continue here. Continuing asks
 * the server again, so a page never takes over while another one is still using the session.
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
        <div className="mx-auto mb-3 flex max-w-3xl items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          <EyeIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex-1">
            <div className="font-medium">
              {lease.state === "other"
                ? "다른 창에서 이 대화를 쓰고 있어요"
                : "다른 창이 이 대화를 더 이상 쓰지 않아요"}
            </div>
            <div className="text-muted-foreground">
              {refused && lease.state === "other"
                ? "아직 다른 창에서 쓰고 있어서 이어갈 수 없어요. 그 창을 닫거나 다른 대화로 옮기면 이어갈 수 있어요."
                : "여기서는 읽기만 할 수 있어요. 보내기·승인·중지는 쓰고 있는 창에서만 돼요."}
            </div>
          </div>
          <Button
            size="sm"
            variant={lease.state === "free" ? "default" : "outline"}
            onClick={onContinue}
          >
            이어서 작업
          </Button>
        </div>
      );
  }
}
