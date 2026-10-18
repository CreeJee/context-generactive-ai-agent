import { isTruthy } from "../../../truthy.ts";
import { useState, type ReactNode } from "react";
import type { Types } from "effect";
import type { CardDraft, CardRisk } from "memory-agent";
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
import type { BoardEdit, BoardView, HumanDecisionRequest, KanbanView } from "../../api";
import { koreanLocalTime } from "../../shared/local-time";
import { DecisionPrompt } from "../decision-prompt";
import { cardStatusLabels } from "./board-moves";
import { authorLabel, riskLabels, StatusIcon } from "./card-face";
import { holdReasonNote, holdReasonText } from "./hold-reason";

type BoardCard = BoardView["cards"][number];
type PlanStep = BoardCard["card"];
type LoopCard = Extract<KanbanView, { readonly active: true }>["cards"][number];

/** What the peek panel shows: a new card's form, or one card. */
export type Peek =
  | { readonly _tag: "New" }
  | { readonly _tag: "Card"; readonly cardId: string; readonly editing: boolean };

const riskItems = [
  { value: "none", label: "지정 안 함" },
  { value: "low", label: riskLabels.low },
  { value: "medium", label: riskLabels.medium },
  { value: "high", label: riskLabels.high },
] as const;

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
const ids = (text: string) =>
  text
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

/** The editor's text fields; contract fields left empty are cleared. */
interface CardForm {
  readonly title: string;
  readonly description: string;
  readonly dependsOn: string;
  readonly acceptanceCriteria: string;
  readonly outcome: string;
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
  outcome: card?.outcome ?? "",
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
  readonly onEdit: (editing: boolean) => void;
  readonly onIntent: (intent: "Hold" | "Release" | "Requeue", cardId: string) => void;
  readonly onClose: () => void;
  /** Resolves with an error message, or null once the change was accepted. */
  readonly onSubmit: (edit: BoardEdit) => Promise<string | null>;
}) {
  const hold = loopCard?.reason ?? null;
  const holdNote = hold === null ? null : holdReasonNote(hold);
  const content = (): ReactNode => {
    switch (peek._tag) {
      case "New":
        return (
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
        );
      case "Card": {
        if (entry === null)
          return (
            <SheetHeader>
              <SheetTitle>카드를 찾을 수 없어요</SheetTitle>
              <SheetDescription>취소됐거나 다른 카드로 바뀌었어요.</SheetDescription>
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
                  {cardStatusLabels[card.status]}
                  <span className="font-mono">· {card.id}</span>
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
              {(hold !== null || changePending) && (
                <div className="space-y-2 rounded-md border border-dashed px-3 py-2" role="status">
                  {hold !== null && <p>사유: {holdReasonText(hold)}</p>}
                  {holdNote !== null && (
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      검증 의견: {holdNote}
                    </p>
                  )}
                  {changePending && <p>오케스트레이터가 이 카드의 변경 요청을 확인하고 있어요.</p>}
                  {loopCard?.requeueable === true && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || intentPending}
                      onClick={() => onIntent("Requeue", card.id)}
                    >
                      다시 대기열에
                    </Button>
                  )}
                </div>
              )}
              {peek.editing ? (
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
                <CardDetails card={card} titleOf={titleOf} lastChange={lastChange} />
              )}
            </div>
            {!peek.editing && (
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
                      {card.hold === undefined ? "보류" : "보류 해제"}
                    </Button>
                  )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!editable}
                  onClick={() => onEdit(true)}
                >
                  {card.status === "in_progress" ? "수정 요청" : "편집"}
                </Button>
              </SheetFooter>
            )}
          </>
        );
      }
    }
  };
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
  lastChange,
}: {
  readonly card: PlanStep;
  readonly titleOf: (cardId: string) => string;
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
      <span className="text-muted-foreground">없음</span>
    );
  return (
    <div className="space-y-4">
      {card.description.trim().length > 0 && (
        <p className="whitespace-pre-wrap">{card.description}</p>
      )}
      <DataList className="items-start">
        <DataListItem term="의존">
          {card.dependsOn.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {card.dependsOn.map((id) => (
                <Badge key={id} variant="secondary">
                  {titleOf(id)}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">없음</span>
          )}
        </DataListItem>
        <DataListItem term="완료 조건">{list(card.acceptanceCriteria)}</DataListItem>
        {isTruthy(card.outcome) && <DataListItem term="결과">{card.outcome}</DataListItem>}
        {isTruthy(card.boundaries) && (
          <DataListItem term="경계">{list(card.boundaries)}</DataListItem>
        )}
        {isTruthy(card.risk) && <DataListItem term="위험">{riskLabels[card.risk]}</DataListItem>}
        {isTruthy(card.requiredEvidence) && (
          <DataListItem term="필요한 근거">{list(card.requiredEvidence)}</DataListItem>
        )}
        {card.evidence.length > 0 && (
          <DataListItem term="남긴 근거">{list(card.evidence)}</DataListItem>
        )}
        {isTruthy(card.humanDecision) && (
          <DataListItem term="사람 판단">{card.humanDecision}</DataListItem>
        )}
        <DataListItem term="마지막 변경">
          {lastChange === null
            ? "기록 없음"
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
      ? submit({
          _tag: "AddCard",
          planVersion,
          index: cardCount,
          card: {
            title: form.title.trim(),
            description: form.description,
            dependsOn: ids(form.dependsOn),
            acceptanceCriteria: lines(form.acceptanceCriteria),
            ...contractFields(form),
          },
        })
      : submit({
          _tag: "EditCard",
          planVersion,
          cardId: card.id,
          patch: {
            title: form.title.trim(),
            description: form.description,
            dependsOn: ids(form.dependsOn),
            acceptanceCriteria: lines(form.acceptanceCriteria),
            outcome: blankToNull(form.outcome),
            boundaries: listOrNull(form.boundaries),
            risk: form.risk === "none" ? null : form.risk,
            requiredEvidence: listOrNull(form.requiredEvidence),
            humanDecision: blankToNull(form.humanDecision),
          },
        });

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
          <SheetTitle>카드 추가</SheetTitle>
          <SheetDescription>
            저장하면 보드에 바로 반영되고 작성자가 사용자로 남아요.
          </SheetDescription>
        </SheetHeader>
      )}
      <div className={card === null ? "flex-1 overflow-y-auto p-4" : "space-y-3"}>
        {executing && (
          <p className="mb-3 text-muted-foreground">
            진행 중인 카드라 바로 바뀌지 않아요. 변경 요청으로 저장되고 오케스트레이터가 반영할지
            정해요.
          </p>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="card-title">제목</FieldLabel>
            <Input
              id="card-title"
              autoFocus
              value={form.title}
              onChange={(event) => set("title")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-description">설명</FieldLabel>
            <Textarea
              id="card-description"
              value={form.description}
              onChange={(event) => set("description")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-depends">의존 카드</FieldLabel>
            <Input
              id="card-depends"
              value={form.dependsOn}
              onChange={(event) => set("dependsOn")(event.target.value)}
            />
            <FieldDescription>카드 id를 쉼표로 구분해요.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="card-criteria">완료 조건</FieldLabel>
            <Textarea
              id="card-criteria"
              value={form.acceptanceCriteria}
              onChange={(event) => set("acceptanceCriteria")(event.target.value)}
            />
            <FieldDescription>한 줄에 하나씩 적어요.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="card-outcome">결과</FieldLabel>
            <Input
              id="card-outcome"
              value={form.outcome}
              onChange={(event) => set("outcome")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-boundaries">경계</FieldLabel>
            <Textarea
              id="card-boundaries"
              value={form.boundaries}
              onChange={(event) => set("boundaries")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-risk">위험</FieldLabel>
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
            <FieldLabel htmlFor="card-evidence">필요한 근거</FieldLabel>
            <Textarea
              id="card-evidence"
              value={form.requiredEvidence}
              onChange={(event) => set("requiredEvidence")(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="card-decision">사람 판단</FieldLabel>
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
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="mr-auto"
            disabled={pending}
            onClick={() => submit({ _tag: "CancelCard", planVersion, cardId: card.id })}
          >
            카드 취소
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          닫기
        </Button>
        <Button type="submit" size="sm" disabled={pending || form.title.trim().length === 0}>
          {executing ? "변경 요청" : "저장"}
        </Button>
      </div>
    </form>
  );
}

/** Contract fields a new card carries; empty ones are left out. */
function contractFields(form: CardForm) {
  const contract: Types.Mutable<Partial<Pick<CardDraft, ContractKey>>> = {};
  const outcome = blankToNull(form.outcome);
  if (outcome !== null) contract.outcome = outcome;
  const boundaries = listOrNull(form.boundaries);
  if (boundaries !== null) contract.boundaries = boundaries;
  if (form.risk !== "none") contract.risk = form.risk;
  const requiredEvidence = listOrNull(form.requiredEvidence);
  if (requiredEvidence !== null) contract.requiredEvidence = requiredEvidence;
  const humanDecision = blankToNull(form.humanDecision);
  if (humanDecision !== null) contract.humanDecision = humanDecision;
  return contract;
}

type ContractKey = "outcome" | "boundaries" | "risk" | "requiredEvidence" | "humanDecision";
