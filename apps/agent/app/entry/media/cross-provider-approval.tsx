import { overlay } from "overlay-kit";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type { CrossProviderMediaRunApproval } from "../api";

export type ApprovalChoice =
  | { readonly kind: "cancel" }
  | { readonly kind: "once"; readonly approval: CrossProviderMediaRunApproval }
  | { readonly kind: "always" };

/** The server's cross-provider disclosure has three explicit outcomes. */
export function chooseCrossProviderApproval(approval: CrossProviderMediaRunApproval) {
  return overlay.openAsync<ApprovalChoice>(({ isOpen, close, unmount }) => {
    const choose = (choice: ApprovalChoice) => {
      close(choice);
      unmount();
    };
    return (
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) choose({ kind: "cancel" });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>OpenAI 이미지 실행을 허용할까요?</DialogTitle>
            <DialogDescription>
              Claude는 이미지를 직접 생성하지 않습니다. 이미지 프롬프트가 OpenAI로 전송되고 사용량은
              OpenAI 계정에 귀속됩니다.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => choose({ kind: "cancel" })}>
              취소
            </Button>
            <Button variant="outline" onClick={() => choose({ kind: "once", approval })}>
              이번만 허용
            </Button>
            <Button onClick={() => choose({ kind: "always" })}>항상 허용</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  });
}
