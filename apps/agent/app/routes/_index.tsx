import { HydrationBoundary } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ShouldRevalidateFunction } from "react-router";
import { firstScreen } from "~/.server/first-screen";
import { App } from "../entry";
import { firstScreenState } from "../entry/first-screen";
import type { Route } from "./+types/_index";

export function meta() {
  return [{ title: "Agent" }, { name: "description", content: "Run!" }];
}

/** The first screen's queries, filled before the page renders so it does not wait on them. */
export const loader = ({ request }: Route.LoaderArgs) => firstScreen(new URL(request.url));

/**
 * The loader fills the first document only. After that the queries and SSE keep the cache current,
 * so a Back over a `?project=`/`?session=` change does not ask the server again.
 */
export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export default function Agent({ loaderData }: Route.ComponentProps) {
  const state = useMemo(
    () => (loaderData === null ? undefined : firstScreenState(loaderData)),
    [loaderData],
  );
  return (
    <HydrationBoundary state={state}>
      <App />
    </HydrationBoundary>
  );
}
