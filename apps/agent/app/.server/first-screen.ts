import { Clock, Config, Effect, ManagedRuntime, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AppApi } from "memory-agent/app-api";
import { FirstScreenJson } from "~/entry/first-screen";
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
 * What the first screen shows, fetched before the page renders: the project list, and the
 * conversations of `?project=` or, as the page picks, of the first project. Null when the API
 * cannot answer in time; the page's queries then ask on their own and show any failure.
 */
export const firstScreen = (url: URL) =>
  loaderRuntime.runPromise(
    Effect.gen(function* () {
      const { client, fetch } = yield* appApi;
      return yield* Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const projects = yield* client.projects.list({ query: {} });
        const wanted = url.searchParams.get("project");
        const project = projects.find((item) => item.id === wanted) ?? projects[0];
        const sessions =
          project === undefined
            ? null
            : yield* Effect.all(
                {
                  project: Effect.succeed(project.id),
                  active: client.sessions.list({ query: { project: project.id } }),
                  archived: client.sessions.list({ query: { project: project.id, archived: "1" } }),
                },
                { concurrency: "unbounded" },
              );
        return yield* Schema.encodeEffect(FirstScreenJson)({ at, projects, sessions });
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    }).pipe(
      Effect.timeout(firstScreenDeadline),
      Effect.catchCause(() => Effect.succeed(null)),
    ),
  );
