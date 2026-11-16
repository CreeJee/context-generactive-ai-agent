import { overlay } from "overlay-kit";
import { SettingsOverlay, type SettingsPage } from "./settings-dialog";

/** Opens the settings on a project; the dialog reads it from the project list. */
export function openSettingsOverlay({
  projectId,
  initialPage,
  reportLink,
}: {
  readonly projectId: string | null;
  readonly initialPage?: SettingsPage;
  /** Where the general page links to for a problem report. */
  readonly reportLink: string;
}) {
  overlay.open(({ isOpen, close, unmount }) => (
    <SettingsOverlay
      projectId={projectId}
      initialPage={initialPage}
      reportLink={reportLink}
      open={isOpen}
      onClose={() => {
        close();
        unmount();
      }}
    />
  ));
}
