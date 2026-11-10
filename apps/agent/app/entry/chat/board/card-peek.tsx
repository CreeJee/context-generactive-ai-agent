import { isTruthy } from "../../../truthy.ts";
import { useState, type ReactNode } from "react";
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
import { BoardEdit, type BoardView, type HumanDecisionRequest, type KanbanView } from "../../api";
import { koreanLocalTime } from "../../shared/local-time";
import { DecisionPrompt } from "../decision-prompt";
import { canTransfer } from "./board-moves";
import { authorLabel, StatusIcon } from "./card-face";
import { boardCopy } from "./copy";
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
  { value: "none", label: boardCopy.editor.riskNone },
  { value: "low", label: boardCopy.risk.low },
  { value: "medium", label: boardCopy.risk.medium },
  { value: "high", label: boardCopy.risk.high },
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
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const hold = loopCard?.reason ?? null;
  const holdNote = hold === null ? null : holdReasonNote(hold);
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
              <SheetTitle>{boardCopy.peek.missing.title}</SheetTitle>
              <SheetDescription>{boardCopy.peek.missing.body}</SheetDescription>
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
                  {boardCopy.status[card.status]}
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
                  <p>{boardCopy.peek.approval.waiting}</p>
                  {card.approval.review !== undefined && (
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {boardCopy.peek.approval.review(card.approval.review.reason)}
                    </p>
                  )}
                  <p className="text-muted-foreground">{boardCopy.peek.approval.rejectHint}</p>
                  <Button
                    type="button"
                    size="sm"
                    disabled={disabled || closed || intentPending}
                    onClick={() => onIntent("Approve", card.id)}
                  >
                    {boardCopy.peek.approval.approve}
                  </Button>
                </div>
              )}
              {(hold !== null || changePending) && (
                <div className="space-y-2 rounded-md border px-3 py-2" role="status">
                  {hold !== null && <p>{boardCopy.peek.hold.reason(holdReasonText(hold))}</p>}
                  {holdNote !== null && (
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {boardCopy.peek.hold.note(holdNote)}
                    </p>
                  )}
                  {changePending && <p>{boardCopy.peek.hold.changePending}</p>}
                  {loopCard?.requeueable === true && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || intentPending}
                      onClick={() => onIntent("Requeue", card.id)}
                    >
                      {boardCopy.peek.hold.requeue}
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
                    <FieldLabel htmlFor="card-transfer">{boardCopy.peek.transfer.label}</FieldLabel>
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
                          aria-label={boardCopy.peek.transfer.target}
                          className="min-w-40 flex-1"
                        >
                          <SelectValue placeholder={boardCopy.peek.transfer.placeholder} />
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
                        {boardCopy.peek.transfer.submit}
                      </Button>
                    </span>
                    <FieldDescription>{boardCopy.peek.transfer.hint}</FieldDescription>
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
                      {card.hold === undefined
                        ? boardCopy.peek.actions.hold
                        : boardCopy.peek.actions.release}
                    </Button>
                  )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!editable}
                  onClick={() => onEdit(true)}
                >
                  {card.status === "in_progress"
                    ? boardCopy.peek.actions.requestChange
                    : boardCopy.peek.actions.edit}
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
  const list = (items: readonly string[] | undefined) =>
    items !== undefined && items.length > 0 ? (
      <ul className="list-disc space-y-0.5 pl-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    ) : (
      <span className="text-muted-foreground">{boardCopy.peek.details.none}</span>
    );
  return (
    <div className="space-y-4">
      {card.description.trim().length > 0 && (
        <p className="whitespace-pre-wrap">{card.description}</p>
      )}
      <DataList className="items-start">
        <DataListItem term={boardCopy.peek.details.dependsOn}>
          {card.dependsOn.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {card.dependsOn.map((id) => (
                <Badge key={id} variant="secondary">
                  {titleOf(id)}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">{boardCopy.peek.details.none}</span>
          )}
        </DataListItem>
        <DataListItem term={boardCopy.peek.details.acceptanceCriteria}>
          {list(card.acceptanceCriteria)}
        </DataListItem>
        {card.outcomes.length > 0 && (
          <DataListItem term={boardCopy.peek.details.outcomes}>
            <ul className="space-y-1">
              {card.outcomes.map((id) => (
                <li key={id} className="flex items-start gap-1.5">
                  <Badge variant="outline" className="shrink-0">
                    {id}
                  </Badge>
                  <span className={outcomeOf(id) === null ? "text-muted-foreground" : undefined}>
                    {outcomeOf(id) ?? boardCopy.peek.details.outcomeMissing}
                  </span>
                </li>
              ))}
            </ul>
          </DataListItem>
        )}
        {isTruthy(card.boundaries) && (
          <DataListItem term={boardCopy.peek.details.boundaries}>
            {list(card.boundaries)}
          </DataListItem>
        )}
        {isTruthy(card.risk) && (
          <DataListItem term={boardCopy.peek.details.risk}>
            {boardCopy.risk[card.risk]}
          </DataListItem>
        )}
        {isTruthy(card.requiredEvidence) && (
          <DataListItem term={boardCopy.peek.details.requiredEvidence}>
            {list(card.requiredEvidence)}
          </DataListItem>
        )}
        {card.evidence.length > 0 && (
          <DataListItem term={boardCopy.peek.details.evidence}>{list(card.evidence)}</DataListItem>
        )}
        {isTruthy(card.humanDecision) && (
          <DataListItem term={boardCopy.peek.details.humanDecision}>
            {card.humanDecision}
          </DataListItem>
        )}
        <DataListItem term={boardCopy.lastChange.label}>
          {lastChange === null
            ? boardCopy.lastChange.none
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
          <SheetTitle>{boardCopy.editor.newTitle}</SheetTitle>
          <SheetDescription>{boardCopy.editor.newHint}</SheetDescription>
        </SheetHeader>
      )}
      <div className={card === null ? "flex-1 overflow-y-auto p-4" : "space-y-3"}>
        {executing && (
          <p className="mb-3 text-muted-foreground">{boardCopy.editor.executingHint}</p>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="card-title">{boardCopy.editor.title}</FieldLabel>
            <Input
              id="card-title"
              autoFocus
              value={form.title}
              onChange={(event) => set("title")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-description">{boardCopy.editor.description}</FieldLabel>
            <Textarea
              id="card-description"
              value={form.description}
              onChange={(event) => set("description")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-depends">{boardCopy.editor.dependsOn}</FieldLabel>
            <Input
              id="card-depends"
              value={form.dependsOn}
              onChange={(event) => set("dependsOn")(event.target.value)}
            />
            <FieldDescription>{boardCopy.editor.dependsOnHint}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="card-criteria">{boardCopy.editor.acceptanceCriteria}</FieldLabel>
            <Textarea
              id="card-criteria"
              value={form.acceptanceCriteria}
              onChange={(event) => set("acceptanceCriteria")(event.target.value)}
            />
            <FieldDescription>{boardCopy.editor.onePerLine}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="card-boundaries">{boardCopy.editor.boundaries}</FieldLabel>
            <Textarea
              id="card-boundaries"
              value={form.boundaries}
              onChange={(event) => set("boundaries")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-risk">{boardCopy.editor.risk}</FieldLabel>
            <Select
              value={form.risk}
              items={riskItems}
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
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="card-evidence">{boardCopy.editor.requiredEvidence}</FieldLabel>
            <Textarea
              id="card-evidence"
              value={form.requiredEvidence}
              onChange={(event) => set("requiredEvidence")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-decision">{boardCopy.editor.humanDecision}</FieldLabel>
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
              {boardCopy.editor.cancelCard.trigger}
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>{boardCopy.editor.cancelCard.title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {executing
                    ? boardCopy.editor.cancelCard.executing
                    : boardCopy.editor.cancelCard.waiting}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{boardCopy.editor.cancelCard.choices.keep}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => submit(BoardEdit.CancelCard({ planVersion, cardId: card.id }))}
                >
                  {boardCopy.editor.cancelCard.choices.cancel}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {boardCopy.editor.close}
        </Button>
        <Button type="submit" size="sm" disabled={pending || form.title.trim().length === 0}>
          {executing ? boardCopy.editor.requestChange : boardCopy.editor.save}
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
