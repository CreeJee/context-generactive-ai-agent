import { overlay } from "overlay-kit";
import type { Project } from "../api";
import { SettingsOverlay } from "./settings-dialog";

/** Open a settings view with the currently selected project. */
export function openSettingsOverlay(project: Project | null) {
  overlay.open(({ isOpen, close, unmount }) => (
    <SettingsOverlay
      project={project}
      open={isOpen}
      onClose={() => {
        close();
        unmount();
      }}
    />
  ));
}
