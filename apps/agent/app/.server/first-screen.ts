import { type DataTag, dehydrate, QueryClient, type QueryKey } from "@tanstack/react-query";
import { Config, Effect, ManagedRuntime, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AppApi } from "memory-agent/app-api";
import { globalQueries } from "~/entry/queries/global";
import { projectQueries } from "~/entry/queries/project";
import { sessionQueries } from "~/entry/queries/session";
import { serveApi } from "./api.ts";

const loaderRuntime = ManagedRuntime.make(FetchHttpClient.layer);

/** `serveApi` answering in this process; the URL's host is never dialled. */
const inProcess: typeof fetch = (input, init) => serveApi(new Request(input, init));

/**
 * The app API client the loader calls. Under the HMR frontend, Vite proxies `/api` to the stable
 * dev backend (`CONTEXT_AGENT_DEV_BACKEND`), and this process has no agent of its own, so the
 * loader asks that backend too. Everywhere else `serveApi` answers in this process.
 */
const appApi = Effect.gen(function* () {
  const backend = yield* Config.option(Config.String("CONTEXT_AGENT_DEV_BACKEND"));
  const client = yield* HttpApiClient.make(AppApi, {
    baseUrl: Option.getOrElse(backend, () => "http://127.0.0.1"),
  });
  return { client, fetch: Option.isSome(backend) ? globalThis.fetch : inProcess };
});

/**
 * How long the page waits for the first screen. A warm server answers in milliseconds; the first
 * request after a start also builds the agent, and the page renders without waiting for that.
 */
const firstScreenDeadline = "500 millis";

/**
 * A value React Router's turbo-stream carries as it is. A class instance, such as an `Option` or
 * a `DateTime`, would lose its prototype on the way, so its query does not type-check here.
 */
type Plain =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<Plain>
  | { readonly [key: string]: Plain };

/** Runs branches side by side; one failing leaves the others' queries filled. */
const apart = (branches: ReadonlyArray<Effect.Effect<unknown, unknown>>) =>
  Effect.all(branches, { concurrency: "unbounded", mode: "result", discard: true });

/**
 * The page's first screen as query cache state, read before the page renders: the project lists,
 * image settings, the project the page opens (`?project=`, else the first) with its conversations,
 * agents, skills, decisions and boards, and the conversation it opens (`?session=` among the active
 * ones, else the first) with its queue, subagents, approvals, work trace and kanban. Queries that
 * reach a provider, the keychain or a remote endpoint (auth, accounts, quota, models) and the
 * holder-dependent run state are left to the page. Whatever has not answered by the deadline, or
 * failed, is left out too; the page's queries then ask on their own and show any failure.
 */
export const firstScreen = (url: URL) =>
  loaderRuntime.runPromise(
    Effect.gen(function* () {
      const { client: app, fetch } = yield* appApi;
      const cache = new QueryClient();
      /** Reads a query's data as its query function does and keeps it under the query's key. */
      const fill = <A extends Plain, E>(
        queryKey: DataTag<QueryKey, A, unknown>,
        read: Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        Effect.tap(read, (data) => Effect.sync(() => cache.setQueryData(queryKey, data)));

      const conversation = (project: string, session: string) => {
        const params = { params: { session } };
        return apart([
          fill(sessionQueries.queue(project, session).queryKey, app.sessions.queue(params)),
          fill(sessionQueries.subagents(project, session).queryKey, app.sessions.subagents(params)),
          fill(sessionQueries.approvals(project, session).queryKey, app.sessions.approvals(params)),
          fill(sessionQueries.trace(project, session).queryKey, app.trace.sessionTree(params)),
          fill(sessionQueries.kanban(project, session).queryKey, app.sessions.kanban(params)),
        ]);
      };

      const opened = (project: string) => {
        const params = { params: { project } };
        const sessions = Effect.all(
          {
            active: app.sessions.list({ query: { project } }),
            archived: app.sessions.list({ query: { project, archived: "1" } }),
          },
          { concurrency: "unbounded" },
        );
        return apart([
          fill(projectQueries.sessions(project).queryKey, sessions).pipe(
            Effect.flatMap(({ active }) => {
              const wanted = url.searchParams.get("session");
              const session = active.find((item) => item.id === wanted) ?? active[0];
              return session === undefined ? Effect.void : conversation(project, session.id);
            }),
          ),
          fill(projectQueries.agents(project).queryKey, app.projects.agents(params)),
          fill(projectQueries.skills(project).queryKey, app.projects.skills(params)),
          fill(projectQueries.decisions(project).queryKey, app.projects.decisions(params)),
          fill(projectQueries.boards(project).queryKey, app.projects.boards(params)),
        ]);
      };

      yield* apart([
        fill(globalQueries.projects().queryKey, app.projects.list({ query: {} })).pipe(
          Effect.flatMap((projects) => {
            const wanted = url.searchParams.get("project");
            const project = projects.find((item) => item.id === wanted) ?? projects[0];
            return project === undefined ? Effect.void : opened(project.id);
          }),
        ),
        fill(
          globalQueries.hiddenProjects().queryKey,
          app.projects.list({ query: { hidden: "1" } }),
        ),
        fill(globalQueries.imageSettings().queryKey, app.settings.image()),
      ]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.timeout(firstScreenDeadline),
        Effect.ignore,
      );
      return dehydrate(cache);
    }).pipe(Effect.catchCause(() => Effect.succeed(null))),
  );
