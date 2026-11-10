import { isTruthy } from "../../../truthy.ts";
import { useState, type ReactNode } from "react";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Array as Arr, Data, Result, type Types } from "effect";
import type { CardDraft, CardRisk } from "memory-agent";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { DataList, DataListItem } from "../../../components/ui/data-list";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../../components/ui/field";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../../components/ui/sheet";
import { Textarea } from "../../../components/ui/textarea";
import {
  BoardEdit,
  type BoardView,
  type CardStatus,
  type HumanDecisionRequest,
  type KanbanView,
} from "../../api";
import { koreanLocalTime } from "../../shared/local-time";
import { DecisionPrompt } from "../decision-prompt";
import { canTransfer, cardStatusLabels } from "./board-moves";
import { authorLabel, riskLabels, StatusIcon } from "./card-face";
import { holdReasonNote, holdReasonText } from "./hold-reason";

type BoardCard = BoardView["cards"][number];
type PlanStep = BoardCard["card"];
type LoopCard = Extract<KanbanView, { readonly active: true }>["cards"][number];

/** What the peek panel shows: a new card's form, or one card. */
export type Peek = Data.TaggedEnum<{
  New: {};
  Card: { readonly cardId: string; readonly editing: boolean };
}>;
export const Peek = Data.taggedEnum<Peek>();

/** Another conversation of the project whose Plan a card can move to. */
export interface TransferTarget {
  readonly sessionId: string;
  readonly label: string;
}

const riskItems = [
  {
    value: "none",
    label: msg({ message: "지정 안 함", comment: "Risk choice in the card editor: no risk given" }),
  },
  { value: "low", label: riskLabels.low },
  { value: "medium", label: riskLabels.medium },
  { value: "high", label: riskLabels.high },
] as const;

/** The text without its surrounding spaces, unless nothing is left. */
const trimmed = (text: string) => {
  const kept = text.trim();
  return kept.length > 0 ? Result.succeed(kept) : Result.failVoid;
};
const lines = (text: string) => Arr.filterMap(text.split("\n"), trimmed);
const ids = (text: string) => Arr.filterMap(text.split(","), trimmed);

/** The editor's text fields; contract fields left empty are cleared. */
interface CardForm {
  readonly title: string;
  readonly description: string;
  readonly dependsOn: string;
  readonly acceptanceCriteria: string;
  readonly boundaries: string;
  readonly risk: CardRisk | "none";
  readonly requiredEvidence: string;
  readonly humanDecision: string;
}

const formOf = (card: PlanStep | null): CardForm => ({
  title: card?.title ?? "",
  description: card?.description ?? "",
  dependsOn: card?.dependsOn.join(", ") ?? "",
  acceptanceCriteria: card?.acceptanceCriteria.join("\n") ?? "",
  boundaries: card?.boundaries?.join("\n") ?? "",
  risk: card?.risk ?? "none",
  requiredEvidence: card?.requiredEvidence?.join("\n") ?? "",
  humanDecision: card?.humanDecision ?? "",
});

const blankToNull = (text: string) => (text.trim().length === 0 ? null : text.trim());
const listOrNull = (text: string) => {
  const items = lines(text);
  return items.length === 0 ? null : items;
};

/**
 * The right-hand peek panel over the board: a card's details, its decision prompts and its
 * editor, or the form for a new card. Esc closes it and leaves the board open.
 */
export function CardPeek({
  peek,
  entry,
  loopCard,
  decisions,
  titleOf,
  outcomeOf,
  group,
  changePending,
  projectId,
  holder,
  disabled,
  closed,
  planVersion,
  cardCount,
  editPending,
  intentPending,
  kanbanActive,
  transferTargets,
  onTransfer,
  onEdit,
  onIntent,
  onClose,
  onSubmit,
}: {
  readonly peek: Peek;
  /** The peeked card; null for a new card or a card no longer on the board. */
  readonly entry: BoardCard | null;
  readonly loopCard: LoopCard | null;
  readonly decisions: readonly HumanDecisionRequest[];
  readonly titleOf: (cardId: string) => string;
  /** An outcome's text in the current Goal; null when the Goal no longer has it. */
  readonly outcomeOf: (outcomeId: string) => string | null;
  /** The card's conversation, when the board shows several Plans. */
  readonly group: string | null;
  readonly changePending: boolean;
  readonly projectId: string;
  readonly holder: string;
  readonly disabled: boolean;
  readonly closed: boolean;
  readonly planVersion: number;
  readonly cardCount: number;
  readonly editPending: boolean;
  readonly intentPending: boolean;
  /** Holding and requeueing need the kanban loop that assigns cards. */
  readonly kanbanActive: boolean;
  /** Conversations the card may move to; none hides the move. */
  readonly transferTargets: readonly TransferTarget[];
  /** Asks to move the card to that conversation's Plan; the parent confirms and sends. */
  readonly onTransfer: (cardId: string, toSessionId: string) => void;
  readonly onEdit: (editing: boolean) => void;
  readonly onIntent: (intent: "Hold" | "Release" | "Requeue" | "Approve", cardId: string) => void;
  readonly onClose: () => void;
  /** Resolves with an error message, or null once the change was accepted. */
  readonly onSubmit: (edit: BoardEdit) => Promise<string | null>;
}) {
  const { t } = useLingui();
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const hold = loopCard?.reason ?? null;
  const holdNote = hold === null ? null : holdReasonNote(hold);
  // The running board takes any blocked card back: a dead-lettered one continues its delivery,
  // another starts a new failure streak from ready.
  const requeueable = (card: { readonly status: CardStatus }) =>
    loopCard !== null && card.status === "blocked";
  const content = (): ReactNode =>
    Peek.$match(peek, {
      New: () => (
        <CardEditor
          card={null}
          planVersion={planVersion}
          cardCount={cardCount}
          pending={editPending}
          onCancel={onClose}
          onSubmit={(edit) =>
            onSubmit(edit).then((error) => {
              if (error === null) onClose();
              return error;
            })
          }
        />
      ),
      Card: ({ editing }) => {
        if (entry === null)
          return (
            <SheetHeader>
              <SheetTitle>
                <Trans>카드를 찾을 수 없습니다</Trans>
              </SheetTitle>
              <SheetDescription>
                <Trans>취소됐거나 다른 카드로 바뀌었습니다.</Trans>
              </SheetDescription>
            </SheetHeader>
          );
        const { card, lastChange } = entry;
        const editable = !disabled && !closed && card.status !== "done";
        return (
          <>
            <SheetHeader>
              <SheetDescription>
                <span className="flex items-center gap-1.5">
                  <StatusIcon status={card.status} />
                  {t(cardStatusLabels[card.status])}
                  <span className="font-mono">· {card.id}</span>
                  {group !== null && <span>· {group}</span>}
                </span>
              </SheetDescription>
              <SheetTitle>{card.title}</SheetTitle>
            </SheetHeader>
            <div className="flex-1 space-y-4 overflow-y-auto px-4">
              {decisions.map((request) => (
                <DecisionPrompt
                  key={request.requestId}
                  projectId={projectId}
                  holder={holder}
                  request={request}
                  disabled={disabled}
                />
              ))}
              {card.approval !== undefined && (
                <div className="space-y-2 rounded-md border px-3 py-2" role="status">
                  <p>
                    <Trans>
                      Plan 작성자가 실행 중에 더한 카드라 승인을 기다립니다. 승인하기 전에는
                      실행하지 않습니다.
                    </Trans>
                  </p>
                  {card.approval.review !== undefined && (
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      <Trans>자동 검토: {ph({ reason: card.approval.review.reason })}</Trans>
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    <Trans>거절하려면 편집에서 카드를 취소해 주십시오.</Trans>
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    disabled={disabled || closed || intentPending}
                    onClick={() => onIntent("Approve", card.id)}
                  >
                    <Trans comment="Button in the card panel that approves the card to run">
                      승인
                    </Trans>
                  </Button>
                </div>
              )}
              {(hold !== null || changePending || requeueable(card)) && (
                <div className="space-y-2 rounded-md border px-3 py-2" role="status">
                  {hold !== null && (
                    <p>
                      <Trans>사유: {ph({ reason: holdReasonText(hold) })}</Trans>
                    </p>
                  )}
                  {holdNote !== null && (
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      <Trans>검증 의견: {holdNote}</Trans>
                    </p>
                  )}
                  {changePending && (
                    <p>
                      <Trans>오케스트레이터가 이 카드의 변경 요청을 확인하고 있습니다.</Trans>
                    </p>
                  )}
                  {requeueable(card) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || intentPending}
                      onClick={() => onIntent("Requeue", card.id)}
                    >
                      <Trans comment="Button in the card panel that puts a held card back in the queue">
                        다시 대기열에 넣기
                      </Trans>
                    </Button>
                  )}
                </div>
              )}
              {editing ? (
                <CardEditor
                  card={card}
                  planVersion={planVersion}
                  cardCount={cardCount}
                  pending={editPending}
                  onCancel={() => onEdit(false)}
                  onSubmit={(edit) =>
                    onSubmit(edit).then((error) => {
                      if (error === null) onEdit(false);
                      return error;
                    })
                  }
                />
              ) : (
                <CardDetails
                  card={card}
                  titleOf={titleOf}
                  outcomeOf={outcomeOf}
                  lastChange={lastChange}
                />
              )}
              {!editing && transferTargets.length > 0 && canTransfer(card) && (
                <div className="rounded-md border px-3 py-2">
                  <Field>
                    <FieldLabel htmlFor="card-transfer">
                      <Trans>다른 대화로 옮기기</Trans>
                    </FieldLabel>
                    <span className="flex flex-wrap items-center gap-2">
                      <Select
                        value={transferTo}
                        items={transferTargets.map(({ sessionId, label }) => ({
                          value: sessionId,
                          label,
                        }))}
                        disabled={disabled || closed || intentPending}
                        onValueChange={setTransferTo}
                      >
                        <SelectTrigger
                          id="card-transfer"
                          aria-label={t({
                            message: "옮길 대화",
                            comment: "Picker of the conversation a card moves to",
                          })}
                          className="min-w-40 flex-1"
                        >
                          <SelectValue
                            placeholder={t({
                              message: "대화 선택",
                              comment: "Placeholder of the conversation picker",
                            })}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {transferTargets.map((target) => (
                            <SelectItem key={target.sessionId} value={target.sessionId}>
                              {target.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        disabled={transferTo === null || disabled || closed || intentPending}
                        onClick={() => {
                          if (transferTo !== null) onTransfer(card.id, transferTo);
                        }}
                      >
                        <Trans comment="Moves the card to the chosen conversation's Plan">
                          옮기기
                        </Trans>
                      </Button>
                    </span>
                    <FieldDescription>
                      <Trans>
                        그 대화 Plan의 새 카드로 들어갑니다. 의존은 끊기고 처음부터 다시 시작합니다.
                      </Trans>
                    </FieldDescription>
                  </Field>
                </div>
              )}
            </div>
            {!editing && (
              <SheetFooter className="flex-row justify-end">
                {kanbanActive &&
                  (card.hold !== undefined ||
                    card.status === "backlog" ||
                    card.status === "ready") && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mr-auto"
                      disabled={disabled || closed || intentPending}
                      onClick={() =>
                        onIntent(card.hold === undefined ? "Hold" : "Release", card.id)
                      }
                    >
                      {card.hold === undefined ? (
                        <Trans comment="Button in the card panel that puts the card on hold">
                          보류
                        </Trans>
                      ) : (
                        <Trans comment="Button in the card panel that takes the card off hold">
                          보류 해제
                        </Trans>
                      )}
                    </Button>
                  )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!editable}
                  onClick={() => onEdit(true)}
                >
                  {card.status === "in_progress" ? (
                    <Trans comment="Button in the card panel that opens the editor for a change request">
                      수정 요청
                    </Trans>
                  ) : (
                    <Trans comment="Button in the card panel that opens the card editor">
                      편집
                    </Trans>
                  )}
                </Button>
              </SheetFooter>
            )}
          </>
        );
      },
    });
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-md">{content()}</SheetContent>
    </Sheet>
  );
}

function CardDetails({
  card,
  titleOf,
  outcomeOf,
  lastChange,
}: {
  readonly card: PlanStep;
  readonly titleOf: (cardId: string) => string;
  readonly outcomeOf: (outcomeId: string) => string | null;
  readonly lastChange: BoardCard["lastChange"];
}) {
  const { t } = useLingui();
  const none = (
    <span className="text-muted-foreground">
      <Trans comment="A card field with nothing in it">없음</Trans>
    </span>
  );
  const list = (items: readonly string[] | undefined) =>
    items !== undefined && items.length > 0 ? (
      <ul className="list-disc space-y-0.5 pl-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    ) : (
      none
    );
  return (
    <div className="space-y-4">
      {card.description.trim().length > 0 && (
        <p className="whitespace-pre-wrap">{card.description}</p>
      )}
      <DataList className="items-start">
        <DataListItem
          term={<Trans comment="Card field: the cards this card waits for">의존</Trans>}
        >
          {card.dependsOn.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {card.dependsOn.map((id) => (
                <Badge key={id} variant="secondary">
                  {titleOf(id)}
                </Badge>
              ))}
            </span>
          ) : (
            none
          )}
        </DataListItem>
        <DataListItem
          term={<Trans comment="Card field: when the card counts as done">완료 조건</Trans>}
        >
          {list(card.acceptanceCriteria)}
        </DataListItem>
        {card.outcomes.length > 0 && (
          <DataListItem
            term={
              <Trans comment="Card field: the Goal's outcomes the card serves">Goal 결과</Trans>
            }
          >
            <ul className="space-y-1">
              {card.outcomes.map((id) => (
                <li key={id} className="flex items-start gap-1.5">
                  <Badge variant="outline" className="shrink-0">
                    {id}
                  </Badge>
                  <span className={outcomeOf(id) === null ? "text-muted-foreground" : undefined}>
                    {outcomeOf(id) ?? <Trans>지금 Goal에는 없는 결과입니다.</Trans>}
                  </span>
                </li>
              ))}
            </ul>
          </DataListItem>
        )}
        {isTruthy(card.boundaries) && (
          <DataListItem
            term={<Trans comment="Card field: what the card's work must not touch">경계</Trans>}
          >
            {list(card.boundaries)}
          </DataListItem>
        )}
        {isTruthy(card.risk) && (
          <DataListItem
            term={<Trans comment="Card field: how risky the card's work is">위험</Trans>}
          >
            {t(riskLabels[card.risk])}
          </DataListItem>
        )}
        {isTruthy(card.requiredEvidence) && (
          <DataListItem
            term={<Trans comment="Card field: proof the card's work must leave">필요한 근거</Trans>}
          >
            {list(card.requiredEvidence)}
          </DataListItem>
        )}
        {card.evidence.length > 0 && (
          <DataListItem
            term={<Trans comment="Card field: proof the card's work left">남긴 근거</Trans>}
          >
            {list(card.evidence)}
          </DataListItem>
        )}
        {isTruthy(card.humanDecision) && (
          <DataListItem
            term={
              <Trans comment="Card field: what a person must decide for the card">사람 판단</Trans>
            }
          >
            {card.humanDecision}
          </DataListItem>
        )}
        <DataListItem
          term={
            <Trans comment="Card field: who changed the card last, and when">마지막 변경</Trans>
          }
        >
          {lastChange === null
            ? authorLabel(null)
            : `${authorLabel(lastChange.author)} · ${koreanLocalTime(lastChange.at)}`}
        </DataListItem>
      </DataList>
    </div>
  );
}

function CardEditor({
  card,
  planVersion,
  cardCount,
  pending,
  onCancel,
  onSubmit,
}: {
  /** The card to change; null adds a new one. */
  readonly card: PlanStep | null;
  readonly planVersion: number;
  readonly cardCount: number;
  readonly pending: boolean;
  readonly onCancel: () => void;
  /** Resolves with an error message, or null once the change was accepted. */
  readonly onSubmit: (edit: BoardEdit) => Promise<string | null>;
}) {
  const { t } = useLingui();
  const [form, setForm] = useState<CardForm>(() => formOf(card));
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof CardForm) => (value: string) => setForm({ ...form, [key]: value });
  const executing = card?.status === "in_progress";

  const submit = (change: BoardEdit) => void onSubmit(change).then((message) => setError(message));
  const save = () =>
    card === null
      ? submit(
          BoardEdit.AddCard({
            planVersion,
            index: cardCount,
            card: {
              title: form.title.trim(),
              description: form.description,
              dependsOn: ids(form.dependsOn),
              acceptanceCriteria: lines(form.acceptanceCriteria),
              ...contractFields(form),
            },
          }),
        )
      : submit(
          BoardEdit.EditCard({
            planVersion,
            cardId: card.id,
            patch: {
              title: form.title.trim(),
              description: form.description,
              dependsOn: ids(form.dependsOn),
              acceptanceCriteria: lines(form.acceptanceCriteria),
              boundaries: listOrNull(form.boundaries),
              risk: form.risk === "none" ? null : form.risk,
              requiredEvidence: listOrNull(form.requiredEvidence),
              humanDecision: blankToNull(form.humanDecision),
            },
          }),
        );

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {card === null && (
        <SheetHeader>
          <SheetTitle>
            <Trans comment="Title of the form that adds a new card">카드 추가</Trans>
          </SheetTitle>
          <SheetDescription>
            <Trans>저장하면 보드에 바로 반영되고 작성자가 사용자로 남습니다.</Trans>
          </SheetDescription>
        </SheetHeader>
      )}
      <div className={card === null ? "flex-1 overflow-y-auto p-4" : "space-y-3"}>
        {executing && (
          <p className="mb-3 text-muted-foreground">
            <Trans>
              진행 중인 카드라 바로 바뀌지 않습니다. 변경 요청으로 저장되고 오케스트레이터가
              반영할지 정합니다.
            </Trans>
          </p>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="card-title">
              <Trans comment="Card editor field: the card's title">제목</Trans>
            </FieldLabel>
            <Input
              id="card-title"
              autoFocus
              value={form.title}
              onChange={(event) => set("title")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-description">
              <Trans comment="Card editor field: the card's description">설명</Trans>
            </FieldLabel>
            <Textarea
              id="card-description"
              value={form.description}
              onChange={(event) => set("description")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-depends">
              <Trans comment="Card editor field: ids of the cards this card waits for">
                의존 카드
              </Trans>
            </FieldLabel>
            <Input
              id="card-depends"
              value={form.dependsOn}
              onChange={(event) => set("dependsOn")(event.target.value)}
            />
            <FieldDescription>
              <Trans>카드 id를 쉼표로 구분합니다.</Trans>
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="card-criteria">
              <Trans comment="Card field: when the card counts as done">완료 조건</Trans>
            </FieldLabel>
            <Textarea
              id="card-criteria"
              value={form.acceptanceCriteria}
              onChange={(event) => set("acceptanceCriteria")(event.target.value)}
            />
            <FieldDescription>
              <Trans>한 줄에 하나씩 적습니다.</Trans>
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="card-boundaries">
              <Trans comment="Card field: what the card's work must not touch">경계</Trans>
            </FieldLabel>
            <Textarea
              id="card-boundaries"
              value={form.boundaries}
              onChange={(event) => set("boundaries")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-risk">
              <Trans comment="Card field: how risky the card's work is">위험</Trans>
            </FieldLabel>
            <Select
              value={form.risk}
              items={riskItems.map(({ value, label }) => ({ value, label: t(label) }))}
              onValueChange={(value) => {
                const item = riskItems.find((option) => option.value === value);
                if (isTruthy(item)) setForm({ ...form, risk: item.value });
              }}
            >
              <SelectTrigger id="card-risk" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {riskItems.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="card-evidence">
              <Trans comment="Card field: proof the card's work must leave">필요한 근거</Trans>
            </FieldLabel>
            <Textarea
              id="card-evidence"
              value={form.requiredEvidence}
              onChange={(event) => set("requiredEvidence")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-decision">
              <Trans comment="Card field: what a person must decide for the card">사람 판단</Trans>
            </FieldLabel>
            <Input
              id="card-decision"
              value={form.humanDecision}
              onChange={(event) => set("humanDecision")(event.target.value)}
            />
          </Field>
        </FieldGroup>
        {error !== null && (
          <p className="mt-3 text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
        {card !== null && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="mr-auto"
                  disabled={pending}
                />
              }
            >
              <Trans comment="Button in the card editor that cancels the card">카드 취소</Trans>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>이 카드를 취소할까요?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {executing ? (
                    <Trans>실행 중인 Plan이라 오케스트레이터가 확인한 뒤 취소됩니다.</Trans>
                  ) : (
                    <Trans>취소한 카드는 실행되지 않습니다.</Trans>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans comment="Closes the dialog without cancelling the card">그만두기</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => submit(BoardEdit.CancelCard({ planVersion, cardId: card.id }))}
                >
                  <Trans comment="Button in the card editor that cancels the card">카드 취소</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          <Trans comment="Button that closes the card editor">닫기</Trans>
        </Button>
        <Button type="submit" size="sm" disabled={pending || form.title.trim().length === 0}>
          {executing ? (
            <Trans comment="Button that sends the edit as a change request">변경 요청</Trans>
          ) : (
            <Trans comment="Button that saves the card">저장</Trans>
          )}
        </Button>
      </div>
    </form>
  );
}

/** Contract fields a new card carries; empty ones are left out. */
function contractFields(form: CardForm) {
  const contract: Types.Mutable<Partial<Pick<CardDraft, ContractKey>>> = {};
  const boundaries = listOrNull(form.boundaries);
  if (boundaries !== null) contract.boundaries = boundaries;
  if (form.risk !== "none") contract.risk = form.risk;
  const requiredEvidence = listOrNull(form.requiredEvidence);
  if (requiredEvidence !== null) contract.requiredEvidence = requiredEvidence;
  const humanDecision = blankToNull(form.humanDecision);
  if (humanDecision !== null) contract.humanDecision = humanDecision;
  return contract;
}

type ContractKey = "boundaries" | "risk" | "requiredEvidence" | "humanDecision";
