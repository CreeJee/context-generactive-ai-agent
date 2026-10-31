import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AgentScope, ExternalAgentsOverview } from "../../external-agents/contracts.ts";
import { McpOverview, McpScope } from "../../mcp/contracts.ts";
import { FolderPick, PermissionMode, Project } from "../../projects/contracts.ts";
import { SkillCatalog } from "../../skills/contracts.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";

const appRefusal = refusalWith(appRefusalFields);

/** A project's settings; one left out stays as it is. */
export const ProjectSettings = Schema.Struct({
  crossRecallExcluded: Schema.optional(Schema.Boolean),
  permissionMode: Schema.optional(PermissionMode),
  hidden: Schema.optional(Schema.Boolean),
});
export type ProjectSettings = typeof ProjectSettings.Type;

/**
 * - `trust` { scope, name, trusted }: allow (or stop) starting that exact configuration.
 * - `reconnect` { name }: after automatic reconnecting gave up, try again.
 */
export const ExternalAgentCommand = Schema.TaggedUnion({
  trust: { scope: AgentScope, name: Schema.NonEmptyString, trusted: Schema.Boolean },
  reconnect: { name: Schema.NonEmptyString },
});
export type ExternalAgentCommand = typeof ExternalAgentCommand.Type;

/**
 * - `trust` { scope, name, trusted }: starts that exact configuration; it does not approve any
 *   tool call. Distrusting also forgets the server's OAuth login.
 * - `login` { scope, name }: starts an OAuth login; the answer shows where to log in.
 * - `cancelLogin` / `logout` { scope, name }: stops that login, or forgets the stored one.
 */
export const McpCommand = Schema.TaggedUnion({
  trust: { scope: McpScope, name: Schema.NonEmptyString, trusted: Schema.Boolean },
  login: { scope: McpScope, name: Schema.NonEmptyString },
  cancelLogin: { scope: McpScope, name: Schema.NonEmptyString },
  logout: { scope: McpScope, name: Schema.NonEmptyString },
});
export type McpCommand = typeof McpCommand.Type;

/** The project the path names is not registered. */
const UnknownProject = appRefusal(404, ["project_not_found"]);

/**
 * The directory cannot be a project; `reason` says why: `not_found`, `not_directory`,
 * `overlaps_storage` or `already_registered`.
 */
const ProjectRejected = appRefusal(422, ["project_rejected"]);

/** Every refusal of the group, for `appRefusalStatus`. */
export const projectsRefusals = [UnknownProject, ProjectRejected];

const project = { project: Schema.String };

/** Registered projects and what each one configures (`/api/projects/*`). */
export class ProjectsGroup extends HttpApiGroup.make("projects")
  .add(
    /** Registered project roots; `?hidden=1` lists the archived ones instead. */
    HttpApiEndpoint.get("list", "/api/projects", {
      query: { hidden: Schema.optional(Schema.Literal("1")) },
      success: Schema.Array(Project),
    }),
    /**
     * Registers a directory. File and shell tools may later act inside it, so the path is
     * canonicalized and must not overlap the app's storage directory.
     */
    HttpApiEndpoint.post("add", "/api/projects", {
      payload: Schema.Struct({ root: Schema.NonEmptyString }),
      success: Project.pipe(HttpApiSchema.status(201)),
      error: ProjectRejected,
    }),
    /**
     * Opens the host's folder dialog and answers the chosen folder, `cancelled`, or `unavailable`
     * when this host has no dialog. Nothing is registered; the page adds the answer through `add`.
     */
    HttpApiEndpoint.post("pick", "/api/projects/pick", { success: FolderPick }),
    /**
     * - crossRecallExcluded: this project's memory is not searched from other projects (PRD R08).
     * - permissionMode: `ask` asks for every shell or outside write; `auto` lets a classifier decide.
     * - hidden: take it out of the sidebar. Its sessions, memory and search are untouched, and
     *   adding the same folder again brings it back.
     */
    HttpApiEndpoint.post("update", "/api/projects/:project", {
      params: project,
      payload: ProjectSettings,
      success: Project,
      error: UnknownProject,
    }),
    /**
     * External ACP agents from `<storage>/agents.json` and `<project>/.agents/agents.json`, with
     * trust and connection state. Environment values are hidden.
     */
    HttpApiEndpoint.get("agents", "/api/projects/:project/agents", {
      params: project,
      success: ExternalAgentsOverview,
      error: UnknownProject,
    }),
    /** R17 */
    HttpApiEndpoint.post("agentAction", "/api/projects/:project/agents", {
      params: project,
      payload: ExternalAgentCommand,
      success: ExternalAgentsOverview,
      error: UnknownProject,
    }),
    /**
     * MCP servers from `<storage>/mcp.json` and `<project>/.mcp.json`, with whether each is
     * trusted and running. Environment and header values are never included.
     */
    HttpApiEndpoint.get("mcp", "/api/projects/:project/mcp", {
      params: project,
      success: McpOverview,
      error: UnknownProject,
    }),
    /** R18 */
    HttpApiEndpoint.post("mcpAction", "/api/projects/:project/mcp", {
      params: project,
      payload: McpCommand,
      success: McpOverview,
      error: UnknownProject,
    }),
    /**
     * Skills from `~/.agents/skills` and `<project>/.agents/skills` that conversations in this
     * project can use, and folders that could not be read as skills.
     */
    HttpApiEndpoint.get("skills", "/api/projects/:project/skills", {
      params: project,
      success: SkillCatalog,
      error: UnknownProject,
    }),
  )
  .middleware(SameSite) {}
