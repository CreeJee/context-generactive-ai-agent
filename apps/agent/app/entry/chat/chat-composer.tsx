import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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

/** What each mode button does, shown on hover. */
const modeTitles = {
  goal: msg`결과를 맡기면 보드에서 Plan의 카드를 바로 실행합니다`,
  plan: msg`프로젝트를 변경하지 않은 채 Plan을 만듭니다. 승인하면 보드에서 실행합니다`,
  chat: msg({ message: "일반 대화", comment: "Hover text of the Chat mode button: plain chat" }),
} satisfies Record<(typeof workflowModes)[number], MessageDescriptor>;

const imageFiles = (files: FileList | null) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));

/** The image just generated, with the route that made it and what it cost. */
function GeneratedImage({ image }: { image: GeneratedImageAsset }) {
  const { t } = useLingui();
  const chatModel = image.initiatorChatModel;
  const mediaRoute = image.executorMediaRouteId;
  const { executionMode } = image;
  const usd = image.estimatedCostUsd?.toFixed(4);
  const usage = JSON.stringify(image.usage);
  return (
    <div className="mb-2 overflow-hidden rounded-lg border bg-card">
      <img src={image.url} alt={t`생성된 이미지`} className="max-h-96 w-full object-contain" />
      <div className="space-y-1 border-t p-3 text-xs text-muted-foreground">
        <div>
          <Trans>
            대화 모델: {chatModel} · 실행 경로: {mediaRoute}
          </Trans>
        </div>
        <div>
          <Trans>실행 방식: {executionMode}</Trans>
          {" · "}
          {usd === undefined ? <Trans>예상 비용 미확인</Trans> : <Trans>예상 비용 ${usd}</Trans>}
        </div>
        {image.usage && (
          <div>
            <Trans>사용량: {usage}</Trans>
          </div>
        )}
      </div>
    </div>
  );
}

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
  stoppable,
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
  /** Work goes on that Stop ends: this page's answer, a run it does not read, or delegated work. */
  stoppable: boolean;
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
  const { t } = useLingui();
  const [highlight, setHighlight] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const caretAfterRender = useRef<number | null>(null);
  const suggestions = editingId === null ? suggest(draft, slashContext) : [];
  const highlighted =
    suggestions.find((suggestion) => suggestion.text === highlight) ?? suggestions[0] ?? null;

  const stopLabel = run.cancelling
    ? t({ message: "멈추는 중", comment: "Stop button while the answer is being stopped" })
    : t({ message: "중지", comment: "Button that stops the answer" });

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
            <Trans>승인된 미디어 경로에서 이미지를 생성하고 있습니다…</Trans>
          </div>
        )}
        {generatedImage && <GeneratedImage image={generatedImage} />}
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
                else if (stoppable) onCancel();
              }
            }}
            placeholder={
              waitingForApproval
                ? t`위의 승인 요청에 먼저 답해 주십시오`
                : editingId !== null
                  ? t`Enter를 누르면 고친 내용을 저장합니다`
                  : generating
                    ? t`답변 중에도 이어서 보낼 수 있습니다`
                    : run.workflow?.phase === "shaping" && run.workflow.mode === "goal"
                      ? t`달성할 결과를 입력해 주십시오`
                      : run.workflow?.phase === "shaping"
                        ? t`변경 없이 조사해 세울 Plan의 내용을 입력해 주십시오`
                        : t`메시지를 입력해 주십시오. /로 명령을 부르고 이미지는 붙여넣거나 끌어다 놓습니다`
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
                    aria-label={t`이미지 첨부`}
                    onClick={() => filePicker.current?.click()}
                  />
                }
              >
                <ImagePlusIcon />
              </TooltipTrigger>
              <TooltipContent>
                {imagesSupported ? (
                  <Trans>이미지 첨부</Trans>
                ) : (
                  <Trans>선택한 모델은 이미지를 읽지 못합니다</Trans>
                )}
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
                      aria-label={t`이미지 생성 요청`}
                      aria-pressed={imageIntent}
                      onClick={onToggleImageIntent}
                    />
                  }
                >
                  <WandSparklesIcon />
                </TooltipTrigger>
                <TooltipContent>
                  {imageSettings.imageGenerationEnabled ? (
                    imageIntent ? (
                      <Trans>이미지 생성 모드 끄기</Trans>
                    ) : (
                      <Trans>이번 요청에서만 이미지 생성</Trans>
                    )
                  ) : (
                    <Trans>설정에서 이미지 생성을 먼저 켜 주십시오</Trans>
                  )}
                </TooltipContent>
              </Tooltip>
            )}
            <ComposerStatus mode={composerMode} />
            <ToggleGroup
              aria-label={t({
                message: "입력 방식",
                comment: "Accessible name of the Chat/Goal/Plan mode buttons in the composer",
              })}
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
                  title={t(modeTitles[mode])}
                >
                  {modeLabels[mode]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="ml-auto flex items-center gap-3">
              <ComposerShortcuts mode={composerMode} />
              {stoppable && editingId === null && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <PromptInputButton
                        variant="outline"
                        disabled={run.cancelling || mutationBlocked}
                        aria-label={stopLabel}
                        onClick={onCancel}
                      />
                    }
                  >
                    {run.cancelling ? <Spinner /> : <SquareIcon className="fill-current" />}
                  </TooltipTrigger>
                  <TooltipContent>
                    {run.cancelling ? stopLabel : <Trans>중지(입력창이 비었을 때 Esc)</Trans>}
                  </TooltipContent>
                </Tooltip>
              )}
              <PromptInputButton
                type="submit"
                variant="default"
                disabled={editingId !== null ? mutationBlocked : !canSend}
                aria-label={
                  editingId !== null
                    ? t({
                        message: "저장",
                        comment: "Submit button while editing a queued message",
                      })
                    : generating
                      ? t`대기열에 넣기`
                      : t({ message: "전송", comment: "Submit button that sends the message" })
                }
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
