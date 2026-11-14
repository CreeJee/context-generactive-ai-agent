import { overlay } from "overlay-kit";
import { SettingsOverlay, type SettingsPage } from "./settings-dialog";

/** Opens the settings on a project; the dialog reads it from the project list. */
export function openSettingsOverlay({
  projectId,
  initialPage,
}: {
  readonly projectId: string | null;
  readonly initialPage?: SettingsPage;
}) {
  overlay.open(({ isOpen, close, unmount }) => (
    <SettingsOverlay
      projectId={projectId}
      initialPage={initialPage}
      open={isOpen}
      onClose={() => {
        close();
        unmount();
      }}
    />
  ));
}
