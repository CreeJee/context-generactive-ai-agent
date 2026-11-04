import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { expect } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";
import "../../app.css";
import { Sidebar, SidebarProvider, SidebarRail } from "./sidebar";

/** The page's part: open/collapsed comes back to the harness through the provider's callback. */
function Harness({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <SidebarProvider
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange(next);
      }}
    >
      <Sidebar>
        <SidebarRail />
      </Sidebar>
      <div data-testid="state">{open ? "expanded" : "collapsed"}</div>
    </SidebarProvider>
  );
}

const sdkCall = Effect.fn("RailTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

it.live("a plain click toggles and a drag's closing click does not", () =>
  Effect.gen(function* () {
    const changes: boolean[] = [];
    // The sidebar and its rail are a desktop panel from the `md` breakpoint up; the default test
    // viewport is narrower.
    yield* sdkCall(() => page.viewport(1024, 768));
    const screen = yield* sdkCall(() =>
      render(<Harness onOpenChange={(open) => changes.push(open)} />),
    );

    // A plain click (no move past the threshold) toggles the sidebar.
    const rail = yield* sdkCall(() =>
      Promise.resolve(screen.getByRole("button", { name: "Toggle Sidebar" })),
    );
    yield* sdkCall(() => rail.click());
    yield* sdkCall(() => expect.element(screen.getByText("collapsed")).toBeVisible());
    // Collapsed, the rail straddles the window's left edge, so its center is off screen; a person
    // clicks the part still showing.
    yield* sdkCall(() => rail.click({ position: { x: 12, y: 12 } }));
    yield* sdkCall(() => expect.element(screen.getByText("expanded")).toBeVisible());

    // A drag past the threshold resizes; the click that ends it must not also toggle. Pointer
    // events are dispatched at the element and window, mirroring the browser's own order.
    yield* Effect.sync(() => {
      // SAFETY: the rail renders exactly one <button>, so its handle is that button.
      const target = rail.element() as HTMLElement;
      const point = (type: string, x: number) =>
        target.dispatchEvent(
          type === "pointermove" || type === "pointerup"
            ? new PointerEvent(type, { bubbles: true, clientX: x })
            : new PointerEvent(type, { bubbles: true, button: 0, clientX: x }),
        );
      const rect = target.getBoundingClientRect();
      point("pointerdown", rect.left);
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + 24 }));
      window.dispatchEvent(new PointerEvent("pointerup"));
      target.click();
    });
    yield* sdkCall(() => expect.poll(() => changes.length).toBe(2));
    yield* sdkCall(() => expect.element(screen.getByText("expanded")).toBeVisible());
  }),
);
