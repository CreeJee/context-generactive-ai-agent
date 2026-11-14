import { Trans } from "@lingui/react/macro";
import { overlay } from "overlay-kit";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { QuerySection } from "../queries/boundary";
import { ImprovementSettings } from "./pages/improvements";

/** Opens the improvement reports of the open projects' repositories, outside the settings. */
export function openImprovementsOverlay() {
  overlay.open(({ isOpen, close, unmount }) => (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (next) return;
        close();
        unmount();
      }}
    >
      <DialogContent className="flex h-[min(40rem,calc(100dvh-2rem))] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            <Trans comment="Title of the project improvement dialog">프로젝트 개선</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans comment="Description of the project improvement dialog">
              열린 프로젝트 전체의 사용 기록에서 찾습니다.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-2">
          <QuerySection>
            <ImprovementSettings />
          </QuerySection>
        </div>
      </DialogContent>
    </Dialog>
  ));
}
