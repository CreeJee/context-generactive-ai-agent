import { ArrowUpIcon, CheckIcon, ImagePlusIcon, SquareIcon, WandSparklesIcon } from "lucide-react";
import { type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Command } from "~/components/ui/command";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputTextarea,
} from "~/components/ui/prompt-input";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { acceptedImageTypes, useDraftImages } from "./draft-images";
import { DraftImageTray } from "./images";
import { ComposerShortcuts, ComposerStatus, type ComposerMode } from "./composer-status";
import { QueuePanel } from "./queue-panel";
import { SlashPalette } from "./slash-palette";
import { suggest, type SlashContext } from "./slash-commands";
import { phaseLabels } from "./workflow-panel";
import type { GeneratedImageAsset, ImageFeatureStatus, QueuedMessage, WorkflowPhase } from "../api";
import type { useRunState } from "../session/use-run-state";

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
  onWorkflowPhase,
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
  onWorkflowPhase: (phase: WorkflowPhase) => void;
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
            승인된 미디어 경로에서 이미지를 생성하고 있어요…
          </div>
        )}
        {generatedImage && (
          <div className="mb-2 overflow-hidden rounded-lg border bg-card">
            <img
              src={generatedImage.url}
              alt="생성된 이미지"
              className="max-h-96 w-full object-contain"
            />
            <div className="space-y-1 border-t p-3 text-xs text-muted-foreground">
              <div>
                대화 모델: {generatedImage.initiatorChatModel} · 실행 경로:{" "}
                {generatedImage.executorMediaRouteId}
              </div>
              <div>
                실행 방식: {generatedImage.executionMode}
                {generatedImage.estimatedCostUsd === undefined
                  ? " · 예상 비용 미확인"
                  : ` · 예상 비용 $${generatedImage.estimatedCostUsd.toFixed(4)}`}
              </div>
              {generatedImage.usage && <div>사용량: {JSON.stringify(generatedImage.usage)}</div>}
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
              if (!suggestions.length || (event.key !== "ArrowDown" && event.key !== "ArrowUp"))
                event.stopPropagation();
              if (suggestions.length > 0 && highlighted) {
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
                ? "위의 승인 요청에 먼저 답해 주세요"
                : editingId !== null
                  ? "Enter를 누르면 고친 내용을 저장해요"
                  : generating
                    ? "답변 중에도 이어서 보낼 수 있어요"
                    : run.workflow?.phase === "goal"
                      ? "달성할 결과를 입력하세요"
                      : run.workflow?.phase === "plan"
                        ? "변경 없이 조사해서 계획할 내용을 입력하세요"
                        : "메시지를 입력하세요. /로 명령을 부르고, 이미지는 붙여넣거나 끌어다 놓아요"
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
                    aria-label="이미지 첨부"
                    onClick={() => filePicker.current?.click()}
                  />
                }
              >
                <ImagePlusIcon />
              </TooltipTrigger>
              <TooltipContent>
                {imagesSupported ? "이미지 첨부" : "선택한 모델은 이미지를 읽지 못해요"}
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
                      aria-label="이미지 생성 요청"
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
                      ? "이미지 생성 모드 끄기"
                      : "이번 요청에서만 이미지 생성"
                    : "설정에서 이미지 생성을 먼저 켜세요"}
                </TooltipContent>
              </Tooltip>
            )}
            <ComposerStatus mode={composerMode} />
            <div
              className="flex items-center rounded-md border bg-muted/30 p-0.5"
              role="group"
              aria-label="입력 방식"
            >
              {(["chat", "goal", "plan"] as const).map((phase) => (
                <Button
                  key={phase}
                  type="button"
                  size="xs"
                  variant={(run.workflow?.phase ?? "chat") === phase ? "secondary" : "ghost"}
                  disabled={
                    !run.actions?.phases[phase].allowed ||
                    run.controlling ||
                    mutationBlocked ||
                    generating ||
                    generatingImage ||
                    editingId !== null
                  }
                  aria-pressed={(run.workflow?.phase ?? "chat") === phase}
                  title={
                    phase === "goal"
                      ? "결과를 맡기면 조사, 수정, 검증까지 진행해요"
                      : phase === "plan"
                        ? "프로젝트를 변경하지 않고 실행 계획을 만들어요"
                        : "일반 대화"
                  }
                  onClick={() => onWorkflowPhase(phase)}
                >
                  {phaseLabels[phase]}
                </Button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-3">
              <ComposerShortcuts mode={composerMode} />
              {generating && editingId === null && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <PromptInputButton
                        variant="outline"
                        disabled={run.cancelling || mutationBlocked}
                        aria-label={run.cancelling ? "멈추는 중" : "중지"}
                        onClick={onCancel}
                      />
                    }
                  >
                    {run.cancelling ? <Spinner /> : <SquareIcon className="fill-current" />}
                  </TooltipTrigger>
                  <TooltipContent>
                    {run.cancelling ? "멈추는 중" : "중지(입력창이 비었을 때 Esc)"}
                  </TooltipContent>
                </Tooltip>
              )}
              <PromptInputButton
                type="submit"
                variant="default"
                disabled={editingId !== null ? mutationBlocked : !canSend}
                aria-label={editingId !== null ? "저장" : generating ? "대기열에 넣기" : "전송"}
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
