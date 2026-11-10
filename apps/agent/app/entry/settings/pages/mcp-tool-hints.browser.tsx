import { it } from "@effect/vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Cause, Effect } from "effect";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import "../../../app.css";
import { McpCommand, type McpServerView } from "../../api";
import { McpToolHints } from "./mcp-tool-hints";

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

const none = { readOnly: null, destructive: null, idempotent: null, openWorld: null };
const tools = [
  // The server says nothing: the spec assumes it may delete and reaches outside.
  { name: "push", server: none, user: none },
  // The server marks it read-only and local.
  { name: "explore", server: { ...none, readOnly: true, openWorld: false }, user: none },
];
const server = {
  scope: "project",
  name: "codegraph",
  transport: "stdio",
  target: "codegraph serve",
  envNames: [],
  headerNames: [],
  shadowed: false,
  signedIn: false,
  state: { _tag: "connected", tools },
} satisfies McpServerView;

it.effect("shows each tool's hints and sends the user's own value for one", () =>
  Effect.gen(function* () {
    const run = vi.fn((_command: McpCommand) => Promise.resolve());
    const screen = yield* sdkCall(() =>
      render(
        <I18nProvider i18n={i18n}>
          <McpToolHints server={server} tools={tools} busy={false} run={run} />
        </I18nProvider>,
      ),
    );
    yield* sdkCall(() => screen.getByRole("button", { name: "도구 2개 분류" }).click());
    yield* sdkCall(() => expect.element(screen.getByText("읽기 전용")).toBeVisible());
    // An unmarked tool shows the spec's cautious default.
    yield* sdkCall(() => expect.element(screen.getByText("지우거나 덮어씀").first()).toBeVisible());
    // A read-only tool is not asked what its changes do.
    yield* sdkCall(() =>
      expect.element(screen.getByRole("combobox", { name: "다시 불러도 같음" })).toBeVisible(),
    );
    expect(screen.getByRole("combobox", { name: "다시 불러도 같음" }).elements()).toHaveLength(1);
    yield* sdkCall(() => screen.getByRole("combobox", { name: "읽기만 함" }).first().click());
    yield* sdkCall(() => screen.getByRole("option", { name: "예" }).click());
    expect(run).toHaveBeenCalledWith(
      McpCommand.toolHint({
        scope: "project",
        name: "codegraph",
        tool: "push",
        hint: "readOnly",
        value: true,
      }),
    );
  }),
);
