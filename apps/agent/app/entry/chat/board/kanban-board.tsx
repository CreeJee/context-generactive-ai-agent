import { isTruthy } from "../../../truthy.ts";
import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Activators,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type KeyboardSensorOptions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCss } from "@dnd-kit/utilities";
import { ChevronsLeftRightIcon, ChevronsRightLeftIcon, GripVerticalIcon } from "lucide-react";
import { cn } from "cn";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { Button } from "../../../components/ui/button";
import type { BoardView, CardStatus } from "../../api";
import {
  boardColumns,
  cardStatusLabels,
  DropOutcome,
  dropOutcome,
  type DropContext,
} from "./board-moves";
import { CardFace, StatusIcon, type CardSignals } from "./card-face";

type BoardCard = BoardView["cards"][number];

declare module "react" {
  /** Dynamic values the board's classes read: `w-(--board-progress)`, `transform-(--…)`. */
  interface CSSProperties {
    readonly "--board-card-offset"?: string;
    readonly "--board-progress"?: string;
  }
}

/** Columns a viewer folded away; kept per browser, like the sidebar's open sections. */
const collapsedColumnsAtom = atomWithStorage<readonly CardStatus[]>(
  "context-agent-board-collapsed-columns",
  [],
);

const columnId = (status: CardStatus) => `column:${status}`;

/**
 * The keyboard picks a card up only from its grip. Enter and Space on the card itself open it, so
 * the same keys cannot also start a drag there.
 */
class GripKeyboardSensor extends KeyboardSensor {
  static override activators: Activators<KeyboardSensorOptions> = KeyboardSensor.activators.map(
    (activator) => ({
      ...activator,
      handler: (event, options, context) =>
        event.target instanceof HTMLElement &&
        event.target.dataset.boardGrip !== undefined &&
        activator.handler(event, options, context),
    }),
  );
}

/**
 * Under the pointer first, so an empty column takes a card dropped on it; the keyboard has no
 * pointer and moves between the nearest cards and columns.
 */
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCorners(args);
};

/** What a drop on another column asks the server for, as the board says it. */
const sendLabels = {
  Hold: "보류해요",
  Release: "보류를 풀어요",
  Requeue: "다시 대기열에 넣어요",
} as const satisfies Record<"Hold" | "Release" | "Requeue", string>;

const screenReaderInstructions = {
  draggable:
    "카드를 옮기려면 스페이스나 엔터를 눌러 집고, 화살표 키로 옮긴 뒤 스페이스나 엔터로 놓아요. Esc를 누르면 취소해요.",
};

/** Which card the j/k and arrow keys move focus to. */
const neighbor = (
  columns: ReadonlyArray<readonly string[]>,
  current: string,
  key: string,
): string | null => {
  const column = columns.findIndex((ids) => ids.includes(current));
  if (column < 0) return null;
  const row = columns[column]?.indexOf(current) ?? 0;
  const across = (step: number) => {
    for (let next = column + step; next >= 0 && next < columns.length; next += step) {
      const ids = columns[next] ?? [];
      if (ids.length > 0) return ids[Math.min(row, ids.length - 1)] ?? null;
    }
    return null;
  };
  switch (key) {
    case "j":
    case "ArrowDown":
      return columns[column]?.[row + 1] ?? null;
    case "k":
    case "ArrowUp":
      return row > 0 ? (columns[column]?.[row - 1] ?? null) : null;
    case "h":
    case "ArrowLeft":
      return across(-1);
    case "l":
    case "ArrowRight":
      return across(1);
    default:
      return null;
  }
};

/**
 * The kanban board: every status column side by side, each scrolling on its own under a fixed
 * header. Cards are dragged with the mouse, a touch hold or the keyboard; what a drop would do is
 * shown while dragging, and the parent carries it out.
 */
export function KanbanBoard({
  cards,
  signalsOf,
  context,
  disabled,
  busy,
  onOpen,
  onReorder,
  onSend,
  onAskChange,
  onRefused,
  onDraggingChange,
}: {
  /** The cards as the board shows them, in Plan order. */
  readonly cards: readonly BoardCard[];
  readonly signalsOf: (cardId: string) => CardSignals;
  readonly context: DropContext;
  /** Nothing can be dragged, as when the page only reads the session. */
  readonly disabled: boolean;
  /** A request is being sent; cards wait for its answer before they can be dragged again. */
  readonly busy: boolean;
  readonly onOpen: (cardId: string) => void;
  /** The card takes the place of `at` in its column. */
  readonly onReorder: (cardId: string, at: string) => void;
  /** Asks the server to hold, release or requeue the card; `lands` is where it is expected. */
  readonly onSend: (
    cardId: string,
    intent: "Hold" | "Release" | "Requeue",
    lands: CardStatus,
  ) => void;
  readonly onAskChange: (cardId: string) => void;
  readonly onRefused: (reason: string) => void;
  /** Whether a card is picked up, so Esc then only puts it back. */
  readonly onDraggingChange: (dragging: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useAtom(collapsedColumnsAtom);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<CardStatus | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(GripKeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byStatus = (status: CardStatus) => cards.filter(({ card }) => card.status === status);
  const entryOf = (id: UniqueIdentifier) => cards.find(({ card }) => card.id === id) ?? null;
  const titleOf = (id: UniqueIdentifier) => entryOf(id)?.card.title ?? String(id);
  const statusOf = (id: UniqueIdentifier): CardStatus | null =>
    boardColumns.find((status) => columnId(status) === id) ?? entryOf(id)?.card.status ?? null;
  const active = activeId === null ? null : entryOf(activeId);
  const outcomeOn = (status: CardStatus): DropOutcome | null =>
    active === null ? null : dropOutcome(active.card, status, context);
  const overOutcome = overStatus === null ? null : outcomeOn(overStatus);
  const overRefused = DropOutcome.$is("Refused")(overOutcome);

  const describe = (id: UniqueIdentifier, over: UniqueIdentifier | null) => {
    const card = entryOf(id)?.card;
    const status = over === null ? null : statusOf(over);
    if (card === undefined || status === null) return `${titleOf(id)} 카드가 놓을 곳 밖에 있어요.`;
    return DropOutcome.$match(dropOutcome(card, status, context), {
      Reorder: () => `${card.title} 카드가 ${cardStatusLabels[status]} 열 안에 있어요.`,
      Send: ({ intent }) => `${card.title} 카드를 ${sendLabels[intent]}.`,
      AskChange: () => `${card.title} 카드는 진행 중이라 옮기지 않고 수정 요청을 남길 수 있어요.`,
      Refused: ({ reason }) => `${cardStatusLabels[status]} 열에는 놓을 수 없어요. ${reason}`,
    });
  };
  const announcements: Announcements = {
    onDragStart: ({ active: picked }) => `${titleOf(picked.id)} 카드를 집었어요.`,
    onDragOver: ({ active: picked, over }) => describe(picked.id, over?.id ?? null),
    onDragEnd: ({ active: picked, over }) =>
      over === null
        ? `${titleOf(picked.id)} 카드를 제자리에 두었어요.`
        : `${titleOf(picked.id)} 카드를 놓았어요. ${describe(picked.id, over.id)}`,
    onDragCancel: ({ active: picked }) => `${titleOf(picked.id)} 카드 옮기기를 취소했어요.`,
  };

  const finish = ({ active: dragged, over }: DragEndEvent) => {
    setActiveId(null);
    setOverStatus(null);
    onDraggingChange(false);
    const entry = entryOf(dragged.id);
    const to = over === null ? null : statusOf(over.id);
    if (entry === null || over === null || to === null) return;
    const { card } = entry;
    return DropOutcome.$match(dropOutcome(card, to, context), {
      Reorder: () => {
        const column = byStatus(to);
        const target = over.id === columnId(to) ? column.at(-1)?.card.id : String(over.id);
        if (target === undefined || target === card.id) return;
        return onReorder(card.id, target);
      },
      Send: ({ intent, lands }) => onSend(card.id, intent, lands),
      AskChange: () => onAskChange(card.id),
      Refused: ({ reason }) => onRefused(reason),
    });
  };

  const columnIds = boardColumns.map((status) => byStatus(status).map(({ card }) => card.id));
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (activeId !== null) {
      // The board sits in a dialog, whose popup keeps arrow keys from reaching the document where
      // dnd-kit's keyboard sensor listens. Hand them over so a picked-up card moves.
      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        event.currentTarget.ownerDocument.dispatchEvent(
          new KeyboardEvent("keydown", { key: event.key, code: event.code, bubbles: true }),
        );
      }
      return;
    }
    if (!(event.target instanceof HTMLElement)) return;
    const current = event.target.dataset.boardCard;
    if (current === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = neighbor(columnIds, current, event.key);
    if (next === null) return;
    event.preventDefault();
    event.currentTarget
      .querySelector<HTMLElement>(`[data-board-card="${CSS.escape(next)}"]`)
      ?.focus();
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      accessibility={{ announcements, screenReaderInstructions }}
      onDragStart={({ active: picked }) => {
        setActiveId(String(picked.id));
        onDraggingChange(true);
      }}
      onDragOver={({ over }) => setOverStatus(over === null ? null : statusOf(over.id))}
      onDragEnd={finish}
      onDragCancel={() => {
        setActiveId(null);
        setOverStatus(null);
        onDraggingChange(false);
      }}
    >
      <div
        role="group"
        aria-label="칸반 보드"
        onKeyDown={moveFocus}
        className={cn(
          "flex h-full min-h-0 snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-4 sm:snap-none",
          overRefused && "cursor-not-allowed **:cursor-not-allowed",
          active !== null && !overRefused && "cursor-grabbing **:cursor-grabbing",
        )}
      >
        {boardColumns.map((status) => {
          const entries = byStatus(status);
          const folded = collapsed.includes(status);
          const toggle = () =>
            setCollapsed(
              folded ? collapsed.filter((other) => other !== status) : [...collapsed, status],
            );
          return (
            <BoardColumn
              key={status}
              status={status}
              count={entries.length}
              folded={folded}
              outcome={outcomeOn(status)}
              over={overStatus === status}
              onToggle={toggle}
            >
              <SortableContext
                items={entries.map(({ card }) => card.id)}
                strategy={verticalListSortingStrategy}
              >
                {entries.map((entry) => (
                  <SortableCard
                    key={entry.card.id}
                    entry={entry}
                    signals={signalsOf(entry.card.id)}
                    disabled={disabled || context.closed}
                    busy={busy}
                    onOpen={onOpen}
                  />
                ))}
              </SortableContext>
            </BoardColumn>
          );
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {active !== null && (
          <div className="w-64 rotate-1 rounded-md border bg-card p-2.5 shadow-lg ring-1 ring-foreground/10">
            <CardFace entry={active} signals={signalsOf(active.card.id)} />
            {overRefused && (
              <p className="mt-2 rounded-sm bg-destructive/10 px-2 py-1 text-2xs text-destructive">
                {overOutcome.reason}
              </p>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  status,
  count,
  folded,
  outcome,
  over,
  onToggle,
  children,
}: {
  readonly status: CardStatus;
  readonly count: number;
  readonly folded: boolean;
  /** What dropping the dragged card here would do; null while nothing is dragged. */
  readonly outcome: DropOutcome | null;
  readonly over: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: columnId(status) });
  const refused = DropOutcome.$is("Refused")(outcome);
  const label = cardStatusLabels[status];
  /** What dropping here would do, in words; nothing for a reorder inside the column. */
  const hint =
    outcome === null
      ? null
      : DropOutcome.$match(outcome, {
          Reorder: () => null,
          Send: ({ intent }) => `놓으면 ${sendLabels[intent]}.`,
          AskChange: () => "놓으면 수정 요청을 남길지 물어봐요.",
          Refused: ({ reason }) => reason,
        });
  if (folded)
    return (
      <section
        ref={setNodeRef}
        aria-label={`${label} ${count}개, 접힘`}
        className={cn(
          "flex w-10 shrink-0 snap-start flex-col items-center gap-2 rounded-lg bg-muted/40 py-2 transition-opacity",
          refused && "opacity-40",
          over && !refused && "ring-2 ring-primary/50",
        )}
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`${label} 열 펼치기`}
          onClick={onToggle}
        >
          <ChevronsLeftRightIcon />
        </Button>
        <StatusIcon status={status} />
        <span className="text-xs text-muted-foreground">{count}</span>
        <span className="text-xs font-medium [writing-mode:vertical-rl]">{label}</span>
      </section>
    );
  return (
    <section
      ref={setNodeRef}
      aria-label={`${label} ${count}개`}
      className={cn(
        "flex min-w-[min(18rem,85vw)] flex-1 basis-0 snap-start flex-col rounded-lg bg-muted/40 transition-opacity sm:min-w-44",
        refused && "opacity-40",
        over && !refused && "ring-2 ring-primary/50",
      )}
    >
      <header className="flex items-center gap-1.5 px-2.5 pt-2 pb-1.5">
        <StatusIcon status={status} />
        <h3 className="text-xs font-medium">{label}</h3>
        <span className="text-xs text-muted-foreground">{count}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label={`${label} 열 접기`}
          onClick={onToggle}
        >
          <ChevronsRightLeftIcon />
        </Button>
      </header>
      {over && hint !== null && (
        <p
          className={cn(
            "mx-2 mb-1.5 rounded-md px-2 py-1 text-2xs",
            refused ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary",
          )}
        >
          {hint}
        </p>
      )}
      <div className="flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
        {children}
      </div>
    </section>
  );
}

function SortableCard({
  entry,
  signals,
  disabled,
  busy,
  onOpen,
}: {
  readonly entry: BoardCard;
  readonly signals: CardSignals;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onOpen: (cardId: string) => void;
}) {
  const { card } = entry;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id, disabled: disabled || busy });
  return (
    <div
      ref={setNodeRef}
      // dnd-kit computes the offset while sorting; the class reads it from this property.
      style={{ "--board-card-offset": DndCss.Translate.toString(transform) ?? "none" }}
      {...listeners}
      className={cn(
        "group/board-card relative flex transform-(--board-card-offset) touch-manipulation items-start gap-1 rounded-md border bg-card p-2.5 transition-colors hover:border-foreground/20 hover:bg-accent/40",
        isDragging && "opacity-40",
        isTruthy(transition) && "transition-transform duration-200 ease-out",
      )}
    >
      <button
        type="button"
        data-board-card={card.id}
        className="min-w-0 flex-1 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpen(card.id)}
      >
        <CardFace entry={entry} signals={signals} />
      </button>
      {!disabled && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          data-board-grip=""
          {...attributes}
          aria-label={`${card.title} 옮기기`}
          className="-mr-1 grid size-5 shrink-0 cursor-grab place-items-center rounded-sm text-muted-foreground opacity-0 outline-none group-hover/board-card:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:opacity-100"
        >
          <GripVerticalIcon aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}
