import { dehydrate, QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { Project, Session } from "memory-agent/app-api";
import { appQueryKeys } from "./queries/keys";

/**
 * What the index loader fetched at server time `at`: the project list, and the conversations of
 * the project the page opens.
 */
const FirstScreen = Schema.Struct({
  at: Schema.Finite,
  projects: Schema.Array(Project),
  sessions: Schema.NullOr(
    Schema.Struct({
      project: Schema.String,
      active: Schema.Array(Session),
      archived: Schema.Array(Session),
    }),
  ),
});

/** React Router carries loader data as plain values, so the first screen travels as JSON. */
export const FirstScreenJson = Schema.toCodecJson(FirstScreen);

/**
 * The first screen as query cache state for `HydrationBoundary`, under the keys the page's queries
 * use. A query the cache already holds keeps its data unless this is newer.
 */
export function firstScreenState(encoded: typeof FirstScreenJson.Encoded) {
  const screen = Schema.decodeSync(FirstScreenJson)(encoded);
  const seeded = new QueryClient();
  seeded.setQueryData(appQueryKeys.global.projects, screen.projects, { updatedAt: screen.at });
  if (screen.sessions !== null) {
    const { project, active, archived } = screen.sessions;
    seeded.setQueryData(
      appQueryKeys.project.sessions(project),
      { active, archived },
      { updatedAt: screen.at },
    );
  }
  return dehydrate(seeded);
}
