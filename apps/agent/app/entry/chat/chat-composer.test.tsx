import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { ChatComposer } from "./chat-composer";
import { allowedWorkflowActions, workflowFixture } from "../session/workflow-test-fixtures";
import type { useDraftImages } from "./draft-images";

const draftImages = {
  images: [],
  add: () => {},
  remove: () => {},
  clear: () => {},
} satisfies ReturnType<typeof useDraftImages>;

function renderPlanComposer() {
  return renderToStaticMarkup(
    <ChatComposer
      draft=""
      onDraftChange={() => {}}
      editingId={null}
      slashContext={{ agents: [], models: [], skills: [] }}
      draftImages={draftImages}
      queueItems={[]}
      imageSettings={null}
      imageIntent={false}
      onToggleImageIntent={() => {}}
      generatingImage={false}
      generatedImage={null}
      imagesSupported={false}
      mutationBlocked={false}
      generating
      waitingForApproval={false}
      canSend={false}
      composerMode={{ kind: "generating" }}
      run={{
        workflow: workflowFixture,
        actions: allowedWorkflowActions,
        controlling: false,
        cancelling: false,
      }}
      onSubmit={() => {}}
      onAttach={() => {}}
      onEditQueued={() => {}}
      onRemoveQueued={() => {}}
      onConfirmQueued={() => {}}
      onFinishEdit={() => {}}
      onPickQueued={() => {}}
      onCancel={() => {}}
      onClear={() => {}}
      onWorkflowPhase={() => {}}
    />,
  );
}

describe("Plan streaming composer", () => {
  test("keeps stop enabled while phase changes are disabled", () => {
    const html = renderPlanComposer();
    const stop = html.match(/<button[^>]*aria-label="중지"[^>]*>/)?.[0];
    expect(stop).toBeDefined();
    expect(stop).not.toContain('disabled=""');
    const phaseGroup = html.match(/role="group" aria-label="입력 방식"[^>]*>(.*?)<\/div>/)?.[1];
    expect(phaseGroup).toBeDefined();
    const phaseButtons = phaseGroup?.match(/<button[^>]*>/g);
    expect(phaseButtons).toHaveLength(3);
    expect(phaseButtons?.every((button) => button.includes('disabled=""'))).toBe(true);
  });
});
