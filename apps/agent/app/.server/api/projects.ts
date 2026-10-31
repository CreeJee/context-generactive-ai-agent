import { Effect, FileSystem, Match, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ChildProcessSpawner } from "effect/process";
import {
  AppEvents,
  ExternalAgents,
  McpServers,
  type Project,
  ProjectNotFound,
  Projects,
  Skills,
} from "memory-agent";
import { AppApi } from "memory-agent/app-api";
import { pickFolder } from "../folder-picker.ts";

const projectNotFound = () => Effect.fail({ error: "project_not_found" } as const);

/** The projects group of `AppApi` (`/api/projects/*`). */
export const ProjectsApiHandlers = HttpApiBuilder.group(
  AppApi,
  "projects",
  Effect.fn(function* (handlers) {
    const projects = yield* Projects;
    const events = yield* AppEvents;
    const agents = yield* ExternalAgents;
    const servers = yield* McpServers;
    const skills = yield* Skills;
    // The folder dialog runs a process and reads the chosen path.
    const pickerServices = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
    >();

    /**
     * Runs `use` on the project the path names; an unregistered one is refused. These routes
     * declared no other refusals, so any other failure stays a 500, as before.
     */
    const withProject = <A, E, R>(id: string, use: (project: Project) => Effect.Effect<A, E, R>) =>
      projects
        .get(id)
        .pipe(
          Effect.flatMap(use),
          Effect.catchIf(Schema.is(ProjectNotFound), projectNotFound, Effect.die),
        );

    return handlers.handleAll({
      list: ({ query }) =>
        Effect.orDie(
          query.hidden === "1"
            ? Effect.map(projects.listAll, (all) =>
                all.filter((project) => project.hiddenAt !== null),
              )
            : projects.list,
        ),
      add: ({ payload }) =>
        projects.add(payload.root).pipe(
          Effect.tap(() => events.publishGlobal("projects")),
          Effect.catchTag(
            "ProjectRootRejected",
            ({ reason }) => Effect.fail({ error: "project_rejected", reason } as const),
            // `Effect.die` itself would type the other failures as `unknown` and lose the tag.
            (failure) => Effect.die(failure),
          ),
        ),
      pick: () => pickFolder().pipe(Effect.orDie, Effect.provide(pickerServices)),
      update: ({ params, payload }) =>
        withProject(params.project, ({ id }) =>
          Effect.gen(function* () {
            const { crossRecallExcluded, permissionMode, hidden } = payload;
            yield* Effect.transposeOption(
              Option.map(Option.fromUndefinedOr(crossRecallExcluded), (excluded) =>
                projects.setCrossRecallExcluded(id, excluded),
              ),
            );
            yield* Effect.transposeOption(
              Option.map(Option.fromUndefinedOr(permissionMode), (mode) =>
                projects.setPermissionMode(id, mode),
              ),
            );
            yield* Effect.transposeOption(
              Option.map(Option.fromUndefinedOr(hidden), (hide) => projects.setHidden(id, hide)),
            );
            yield* events.publishGlobal("projects");
            return yield* projects.get(id);
          }),
        ),
      agents: ({ params }) => withProject(params.project, agents.overview),
      agentAction: ({ params, payload }) =>
        withProject(params.project, (project) =>
          Match.valueTags(payload, {
            trust: ({ scope, name, trusted }) => agents.setTrusted(project, scope, name, trusted),
            reconnect: ({ name }) => agents.reconnect(project, name),
          }),
        ),
      mcp: ({ params }) => withProject(params.project, servers.overview),
      mcpAction: ({ params, payload }) =>
        withProject(params.project, (project) =>
          Match.valueTags(payload, {
            trust: ({ scope, name, trusted }) => servers.setTrusted(project, scope, name, trusted),
            login: ({ scope, name }) => servers.login(project, scope, name),
            cancelLogin: ({ scope, name }) => servers.cancelLogin(project, scope, name),
            logout: ({ scope, name }) => servers.logout(project, scope, name),
          }),
        ),
      skills: ({ params }) => withProject(params.project, skills.catalog),
    });
  }),
);
