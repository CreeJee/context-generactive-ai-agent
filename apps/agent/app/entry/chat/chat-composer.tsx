import { isTruthy } from "../../truthy.ts";
import { ArrowUpIcon, CheckIcon, ImagePlusIcon, SquareIcon, WandSparklesIcon } from "lucide-react";
import { type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Command } from "~/components/ui/command";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputTextarea,
} from "~/components/ui/prompt-input";
import { Spinner } from "~/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { chatCopy } from "./copy";
import { acceptedImageTypes, useDraftImages } from "./draft-images";
import { DraftImageTray } from "./images";
import { ComposerShortcuts, ComposerStatus, type ComposerMode } from "./composer-status";
import { QueuePanel } from "./queue-panel";
import { SlashPalette } from "./slash-palette";
import { suggest, type SlashContext } from "./slash-commands";
import { composerModeOf, modeLabels } from "./workflow-panel";
import type { GeneratedImageAsset, ImageFeatureStatus, QueuedMessage, WorkflowMove } from "../api";
import type { useRunState } from "../session/use-run-state";

const workflowModes = ["chat", "goal", "plan"] as const satisfies readonly WorkflowMove[];

const copy = chatCopy.composer;

const imageFiles = (files: FileList | null) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));

export interface ChatComposerHandle {
  focus: () => void;
}

/** Controlled message input; only keyboard selection and DOM elements live here. */
export function ChatComposer({
  ref,
  draft,
  onDraftChange,
  editingId,
  slashContext,
  draftImages,
  queueItems,
  imageSettings,
  imageIntent,
  onToggleImageIntent,
  generatingImage,
  generatedImage,
  imagesSupported,
  mutationBlocked,
  generating,
  waitingForApproval,
  canSend,
  composerMode,
  run,
  onSubmit,
  onAttach,
  onEditQueued,
  onRemoveQueued,
  onConfirmQueued,
  onFinishEdit,
  onPickQueued,
  onCancel,
  onClear,
  onWorkflowMode,
}: {
  ref?: Ref<ChatComposerHandle>;
  draft: string;
  onDraftChange: (next: string) => void;
  editingId: string | null;
  slashContext: SlashContext;
  draftImages: ReturnType<typeof useDraftImages>;
  queueItems: readonly QueuedMessage[];
  imageSettings: ImageFeatureStatus | null;
  imageIntent: boolean;
  onToggleImageIntent: () => void;
  generatingImage: boolean;
  generatedImage: GeneratedImageAsset | null;
  imagesSupported: boolean;
  mutationBlocked: boolean;
  generating: boolean;
  waitingForApproval: boolean;
  canSend: boolean;
  composerMode: ComposerMode;
  run: Pick<ReturnType<typeof useRunState>, "workflow" | "actions" | "controlling" | "cancelling">;
  onSubmit: (mode: "queue" | "steer") => void;
  onAttach: (files: readonly File[]) => void;
  onEditQueued: (message: QueuedMessage) => void;
  onRemoveQueued: (message: QueuedMessage) => void;
  onConfirmQueued: (message: QueuedMessage) => void;
  onFinishEdit: () => void;
  onPickQueued: (direction: "up" | "down") => void;
  onCancel: () => void;
  onClear: () => void;
  onWorkflowMode: (mode: (typeof workflowModes)[number]) => void;
}) {
  const [highlight, setHighlight] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const caretAfterRender = useRef<number | null>(null);
  const suggestions = editingId === null ? suggest(draft, slashContext) : [];
  const highlighted =
    suggestions.find((suggestion) => suggestion.text === highlight) ?? suggestions[0] ?? null;

  useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), []);

  const complete = (text: string) => {
    caretAfterRender.current = text.length;
    onDraftChange(text);
  };

  const insertReference = (number: number) => {
    const start = textarea.current?.selectionStart ?? draft.length;
    const end = textarea.current?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const token = `${before.length > 0 && !/\s$/.test(before) ? " " : ""}#${number}${/^\s/.test(after) ? "" : " "}`;
    caretAfterRender.current = start + token.length;
    onDraftChange(before + token + after);
  };

  useLayoutEffect(() => {
    if (editingId === null) return;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(draft.length, draft.length);
    // Selecting an edit targets the end once; later typing uses the browser's own caret.
  }, [editingId]);

  useLayoutEffect(() => {
    const caret = caretAfterRender.current;
    if (caret === null) return;
    caretAfterRender.current = null;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(caret, caret);
  }, [draft]);

  return (
    <Command
      shouldFilter={false}
      loop
      vimBindings={false}
      onValueChange={setHighlight}
      variant="composer"
    >
      <form
        onKeyDown={(event) => {
          if (event.target !== textarea.current) event.stopPropagation();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit("queue");
        }}
      >
        <input
          ref={filePicker}
          type="file"
          accept={acceptedImageTypes}
          multiple
          hidden
          onChange={(event) => {
            onAttach(imageFiles(event.target.files));
            event.target.value = "";
          }}
        />
        {suggestions.length > 0 && highlighted && (
          <SlashPalette
            suggestions={suggestions}
            onPick={(suggestion) => complete(suggestion.text)}
          />
        )}
        {generatingImage && (
          <div className="mb-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            {copy.generatingImage}
          </div>
        )}
        {generatedImage && (
          <div className="mb-2 overflow-hidden rounded-lg border bg-card">
            <img
              src={generatedImage.url}
              alt={copy.generatedAlt}
              className="max-h-96 w-full object-contain"
            />
            <div className="space-y-1 border-t p-3 text-xs text-muted-foreground">
              <div>
                {copy.generatedRoute(
                  generatedImage.initiatorChatModel,
                  generatedImage.executorMediaRouteId,
                )}
              </div>
              <div>
                {copy.executionMode(generatedImage.executionMode)}
                {generatedImage.estimatedCostUsd === undefined
                  ? copy.costUnknown
                  : copy.cost(generatedImage.estimatedCostUsd.toFixed(4))}
              </div>
              {generatedImage.usage && (
                <div>{copy.usage(JSON.stringify(generatedImage.usage))}</div>
              )}
            </div>
          </div>
        )}
        <PromptInput editing={editingId !== null}>
          <QueuePanel
            items={queueItems}
            editingId={editingId}
            readOnly={mutationBlocked}
            onEdit={onEditQueued}
            onRemove={onRemoveQueued}
            onConfirm={onConfirmQueued}
          />
          {editingId === null && draftImages.images.length > 0 && (
            <PromptInputHeader>
              <DraftImageTray
                images={draftImages.images}
                onReference={insertReference}
                onRemove={draftImages.remove}
              />
            </PromptInputHeader>
          )}
          <PromptInputTextarea
            ref={textarea}
            value={draft}
            disabled={mutationBlocked}
            onChange={(event) => onDraftChange(event.target.value)}
            onPaste={(event) => {
              const files = imageFiles(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              onAttach(files);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                event.stopPropagation();
                return;
              }
              if (
                !isTruthy(suggestions.length) ||
                (event.key !== "ArrowDown" && event.key !== "ArrowUp")
              )
                event.stopPropagation();
              if (suggestions.length > 0 && isTruthy(highlighted)) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") return;
                const completes =
                  event.key === "Tab" ||
                  (event.key === "Enter" && !event.shiftKey && highlighted.text !== draft);
                if (completes) {
                  event.preventDefault();
                  complete(highlighted.text);
                  return;
                }
              }
              const steerKeys = event.shiftKey && (event.ctrlKey || event.metaKey);
              if (event.key === "Enter" && steerKeys) {
                event.preventDefault();
                onSubmit("steer");
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit("queue");
              } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                event.preventDefault();
                onPickQueued(event.key === "ArrowUp" ? "up" : "down");
              } else if (event.key === "Escape") {
                if (editingId !== null) onFinishEdit();
                else if (draft.length > 0 || draftImages.images.length > 0 || imageIntent)
                  onClear();
                else if (generating) onCancel();
              }
            }}
            placeholder={
              waitingForApproval
                ? copy.placeholders.approval
                : editingId !== null
                  ? copy.placeholders.editing
                  : generating
                    ? copy.placeholders.generating
                    : run.workflow?.phase === "shaping" && run.workflow.mode === "goal"
                      ? copy.placeholders.goal
                      : run.workflow?.phase === "shaping"
                        ? copy.placeholders.plan
                        : copy.placeholders.idle
            }
            rows={1}
          />
          <PromptInputFooter>
            <Tooltip>
              <TooltipTrigger
                render={
                  <PromptInputButton
                    variant="ghost"
                    disabled={!imagesSupported || mutationBlocked || editingId !== null}
                    aria-label={copy.attachImage}
                    onClick={() => filePicker.current?.click()}
                  />
                }
              >
                <ImagePlusIcon />
              </TooltipTrigger>
              <TooltipContent>
                {imagesSupported ? copy.attachImage : copy.imagesUnsupported}
              </TooltipContent>
            </Tooltip>
            {imageSettings && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <PromptInputButton
                      type="button"
                      variant={imageIntent ? "secondary" : "ghost"}
                      disabled={
                        !imageSettings.imageGenerationEnabled ||
                        mutationBlocked ||
                        generating ||
                        generatingImage ||
                        editingId !== null
                      }
                      aria-label={copy.imageIntent}
                      aria-pressed={imageIntent}
                      onClick={onToggleImageIntent}
                    />
                  }
                >
                  <WandSparklesIcon />
                </TooltipTrigger>
                <TooltipContent>
                  {imageSettings.imageGenerationEnabled
                    ? imageIntent
                      ? copy.imageIntentOff
                      : copy.imageIntentOn
                    : copy.imageGenerationDisabled}
                </TooltipContent>
              </Tooltip>
            )}
            <ComposerStatus mode={composerMode} />
            <ToggleGroup
              aria-label={copy.modeGroup}
              variant="outline"
              size="sm"
              spacing={0}
              value={[composerModeOf(run.workflow)]}
              onValueChange={(pressed) => {
                // Pressing the current mode again releases it; the composer always keeps one.
                const mode = workflowModes.find((candidate) => pressed.includes(candidate));
                if (mode !== undefined) onWorkflowMode(mode);
              }}
            >
              {workflowModes.map((mode) => (
                <ToggleGroupItem
                  key={mode}
                  value={mode}
                  disabled={
                    !isTruthy(run.actions?.moves[mode].allowed) ||
                    run.controlling ||
                    mutationBlocked ||
                    generating ||
                    generatingImage ||
                    editingId !== null
                  }
                  title={copy.modeTitles[mode]}
                >
                  {modeLabels[mode]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="ml-auto flex items-center gap-3">
              <ComposerShortcuts mode={composerMode} />
              {generating && editingId === null && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <PromptInputButton
                        variant="outline"
                        disabled={run.cancelling || mutationBlocked}
                        aria-label={run.cancelling ? copy.stopping : copy.stop}
                        onClick={onCancel}
                      />
                    }
                  >
                    {run.cancelling ? <Spinner /> : <SquareIcon className="fill-current" />}
                  </TooltipTrigger>
                  <TooltipContent>{run.cancelling ? copy.stopping : copy.stopHint}</TooltipContent>
                </Tooltip>
              )}
              <PromptInputButton
                type="submit"
                variant="default"
                disabled={editingId !== null ? mutationBlocked : !canSend}
                aria-label={editingId !== null ? copy.save : generating ? copy.queue : copy.send}
              >
                {editingId !== null ? <CheckIcon /> : <ArrowUpIcon />}
              </PromptInputButton>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </form>
    </Command>
  );
}
