import { overlay } from "overlay-kit";
import type { Project } from "../api";
import { SettingsOverlay } from "./settings-dialog";

/** Open a settings view with the currently selected project. */
export function openSettingsOverlay(
  project: Project | null,
  initialPage: "web" | "compatible" = "web",
) {
  overlay.open(({ isOpen, close, unmount }) => (
    <SettingsOverlay
      project={project}
      initialPage={initialPage}
      open={isOpen}
      onClose={() => {
        close();
        unmount();
      }}
    />
  ));
}
