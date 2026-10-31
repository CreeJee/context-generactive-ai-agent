import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AgentScope, ExternalAgentsOverview } from "../../external-agents/contracts.ts";
import { DecisionInboxItem, ProtectedBranches } from "../../kanban/contracts.ts";
import { McpOverview, McpScope } from "../../mcp/contracts.ts";
import { FolderPick, PermissionMode, Project } from "../../projects/contracts.ts";
import { SkillCatalog } from "../../skills/contracts.ts";
import { ProjectBoard } from "../../workflow/contracts.ts";
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

/**
 * Branches the project's Goals never merge into on their own, and the project's Goals
 * (conversations with workflow state) in the order the scheduler serves them.
 */
export const ProjectKanbanSettings = Schema.Struct({
  protectedBranches: ProtectedBranches,
  goalOrder: Schema.Array(Schema.String),
});
export type ProjectKanbanSettings = typeof ProjectKanbanSettings.Type;

/**
 * - `SetProtectedBranches`: a finished Goal whose target is one of these asks a person (pull
 *   request or manual merge) instead of merging; an empty list protects none.
 * - `MoveGoal`: the conversation's Goal goes in front of `before`, or last, and the project's
 *   boards look again.
 */
export const ProjectKanbanCommand = Schema.TaggedUnion({
  SetProtectedBranches: { protectedBranches: ProtectedBranches },
  MoveGoal: { sessionId: Schema.String, before: Schema.NullOr(Schema.String) },
});
export type ProjectKanbanCommand = typeof ProjectKanbanCommand.Type;

/** The project the path names is not registered. */
const UnknownProject = appRefusal(404, ["project_not_found"]);

/**
 * The directory cannot be a project; `reason` says why: `not_found`, `not_directory`,
 * `overlaps_storage` or `already_registered`.
 */
const ProjectRejected = appRefusal(422, ["project_rejected"]);

/** A conversation the command names is not there. */
const UnknownSession = appRefusal(404, ["session_not_found"]);

/** A branch name the scheduler refuses. */
const InvalidKanbanSettings = appRefusal(400, ["invalid_kanban_settings"]);

/** The Goal order refused the move; the code is the reason. */
const GoalScheduleRefused = appRefusal(409, [
  "goal_missing",
  "self_dependency",
  "other_project",
  "dependency_cycle",
]);

/** Storage failed; the cause stays on the server. */
const KanbanStorageFailed = appRefusal(500, [
  "storage_failed",
  "schedule_storage_failed",
  "kanban_storage_failed",
  "workflow_storage_failed",
]);

/** Every refusal of the group, for `appRefusalStatus`. */
export const projectsRefusals = [
  UnknownProject,
  ProjectRejected,
  UnknownSession,
  InvalidKanbanSettings,
  GoalScheduleRefused,
  KanbanStorageFailed,
];

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
    HttpApiEndpoint.get("kanban", "/api/projects/:project/kanban", {
      params: project,
      success: ProjectKanbanSettings,
      error: [UnknownProject, KanbanStorageFailed],
    }),
    /** Answers the settings as they are after the command. */
    HttpApiEndpoint.post("kanbanAction", "/api/projects/:project/kanban", {
      params: project,
      payload: ProjectKanbanCommand,
      success: ProjectKanbanSettings,
      error: [
        UnknownProject,
        UnknownSession,
        InvalidKanbanSettings,
        GoalScheduleRefused,
        KanbanStorageFailed,
      ],
    }),
    /**
     * Every unarchived conversation's Plan as a board, with its column counts; running boards
     * first, then the most recently changed.
     */
    HttpApiEndpoint.get("boards", "/api/projects/:project/boards", {
      params: project,
      success: Schema.Array(ProjectBoard),
      error: [UnknownProject, KanbanStorageFailed],
    }),
    /**
     * The project inbox: every unanswered card decision across its conversations and their
     * current Goals, oldest first.
     */
    HttpApiEndpoint.get("decisions", "/api/projects/:project/decisions", {
      params: project,
      success: Schema.Array(DecisionInboxItem),
      error: [UnknownProject, KanbanStorageFailed],
    }),
  )
  .middleware(SameSite) {}
