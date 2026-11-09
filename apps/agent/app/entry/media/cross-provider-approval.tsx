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
import { mediaCopy } from "./copy";

export type ApprovalChoice = Data.TaggedEnum<{
  cancel: {};
  once: { readonly approval: CrossProviderMediaRunApproval };
  always: {};
}>;
export const ApprovalChoice = Data.taggedEnum<ApprovalChoice>();

/** The server's cross-provider disclosure has three explicit outcomes. */
export function chooseCrossProviderApproval(approval: CrossProviderMediaRunApproval) {
  const copy = mediaCopy.crossProviderApproval;
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
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.body}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => choose(ApprovalChoice.cancel())}>
              {copy.choices.cancel}
            </Button>
            <Button variant="outline" onClick={() => choose(ApprovalChoice.once({ approval }))}>
              {copy.choices.once}
            </Button>
            <Button variant="outline" onClick={() => choose(ApprovalChoice.always())}>
              {copy.choices.always}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  });
}
