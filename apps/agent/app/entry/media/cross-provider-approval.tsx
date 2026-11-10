import { Trans } from "@lingui/react/macro";
import { Data } from "effect";
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

export type ApprovalChoice = Data.TaggedEnum<{
  cancel: {};
  once: { readonly approval: CrossProviderMediaRunApproval };
  always: {};
}>;
export const ApprovalChoice = Data.taggedEnum<ApprovalChoice>();

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
          if (!open) choose(ApprovalChoice.cancel());
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>OpenAI 이미지 실행을 허용할까요?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Claude는 이미지를 직접 생성하지 않습니다. 이미지 프롬프트가 OpenAI로 전송되고
                사용량은 OpenAI 계정에 귀속됩니다.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => choose(ApprovalChoice.cancel())}>
              <Trans>취소</Trans>
            </Button>
            <Button variant="outline" onClick={() => choose(ApprovalChoice.once({ approval }))}>
              <Trans>이번만 허용</Trans>
            </Button>
            <Button variant="outline" onClick={() => choose(ApprovalChoice.always())}>
              <Trans>항상 허용</Trans>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  });
}
