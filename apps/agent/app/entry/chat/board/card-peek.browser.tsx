import { it } from "@effect/vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Cause, Effect } from "effect";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import "../../../app.css";
import { BoardEdit } from "../../api";
import { CardPeek, Peek } from "./card-peek";

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

const planCards = [
  { id: "a1", title: "토큰 저장" },
  { id: "a2", title: "결제 요청" },
];

/** A card the planner added to the running board, waiting for the user's approval. */
const waiting = {
  card: {
    id: "a2",
    title: "결제 요청",
    description: "",
    dependsOn: ["a1"],
    acceptanceCriteria: [],
    ruleRefs: [],
    outcomes: [],
    status: "backlog",
    evidence: [],
    approval: { requestedBy: { _tag: "User" }, at: "2026-11-15T01:00:00.000Z" },
  },
  lastChange: null,
} as const;

const base = {
  loopCard: null,
  decisions: [],
  titleOf: (cardId: string) => cardId,
  outcomeOf: () => null,
  group: null,
  changePending: false,
  projectId: "project-1",
  holder: "page-1",
  disabled: false,
  closed: false,
  planVersion: 3,
  cardCount: 2,
  planCards,
  editPending: false,
  intentPending: false,
  kanbanActive: true,
  transferTargets: [],
  onTransfer: () => {},
  onEdit: () => {},
  onIntent: () => {},
  onClose: () => {},
};

it.live("card panel rejects a card waiting for approval after one confirmation", () =>
  Effect.gen(function* () {
    const onSubmit = vi.fn((_edit: BoardEdit) => Promise.resolve(null));
    const screen = yield* sdkCall(() =>
      render(
        <I18nProvider i18n={i18n}>
          <QueryClientProvider client={new QueryClient()}>
            <CardPeek
              {...base}
              peek={Peek.Card({ cardId: "a2", editing: false })}
              entry={waiting}
              onSubmit={onSubmit}
            />
          </QueryClientProvider>
        </I18nProvider>,
      ),
    );

    yield* sdkCall(() => screen.getByRole("button", { name: "거절" }).click());
    const confirm = screen.getByRole("alertdialog", { name: "이 카드를 거절할까요?" });
    yield* sdkCall(() => expect.element(confirm).toBeVisible());
    yield* sdkCall(() => confirm.getByRole("button", { name: "카드 거절" }).click());
    expect(onSubmit).toHaveBeenCalledWith(BoardEdit.CancelCard({ planVersion: 3, cardId: "a2" }));
  }),
);

it.live("card editor puts the picked cards in the new card's dependencies", () =>
  Effect.gen(function* () {
    const onSubmit = vi.fn((_edit: BoardEdit) => Promise.resolve(null));
    const screen = yield* sdkCall(() =>
      render(
        <I18nProvider i18n={i18n}>
          <QueryClientProvider client={new QueryClient()}>
            <CardPeek {...base} peek={Peek.New()} entry={null} onSubmit={onSubmit} />
          </QueryClientProvider>
        </I18nProvider>,
      ),
    );

    yield* sdkCall(() => screen.getByRole("textbox", { name: "제목" }).fill("새 카드"));
    yield* sdkCall(() => screen.getByRole("button", { name: "토큰 저장" }).click());
    yield* sdkCall(() => screen.getByRole("button", { name: "저장" }).click());

    const edit = onSubmit.mock.calls[0]?.[0];
    expect(
      edit !== undefined && BoardEdit.$is("AddCard")(edit)
        ? { title: edit.card.title, dependsOn: edit.card.dependsOn }
        : null,
    ).toEqual({ title: "새 카드", dependsOn: ["a1"] });
  }),
);
