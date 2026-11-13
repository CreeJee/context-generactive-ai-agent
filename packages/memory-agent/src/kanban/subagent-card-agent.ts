import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Context, Effect, HashSet, Iterable, Layer, Match, Option, Ref, Schema } from "effect";
import { McpServers, mcpInstructionsForMode } from "../mcp/servers.ts";
import { SecureRandom } from "effect/crypto";
import { ActiveProvider } from "../providers/active-provider.ts";
import type { AgentRole } from "../providers/contracts.ts";
import { Projects, type Project } from "../projects/projects.ts";
import { Sessions } from "../sessions/sessions.ts";
import { Subagents } from "../subagents/subagents.ts";
import { ApprovedTools } from "../tools/approved.ts";
import { gatedToolNames } from "../tools/definitions.ts";
import { FileTools } from "../tools/files.ts";
import { MemoryTools } from "../tools/memory.ts";
import { OutsideTools } from "../tools/outside.ts";
import { runTool, type RunTool } from "../tools/run-tool.ts";
import { SkillTools, type SkillToolset } from "../tools/skills.ts";
import type { PlanStep } from "../workflow/workflow.ts";
import { cardAgentToolNames, verifierToolNames } from "../workflow/card-capabilities.ts";
import {
  CardAgent,
  CardAgentOutcome,
  CardVerdict,
  CardVerifier,
  GoalVerifier,
  OutcomeVerifier,
  type CardAgentRun,
  type CardVerification,
  type GoalVerification,
  type OutcomeVerification,
} from "./card-agent.ts";
import { cardToolProject, type CardWorktree } from "./worktree.ts";
import { CardFailure, VerdictFailure, type AgentFailureCode } from "./failures.ts";
import { fallbackLogged, logFailure } from "../runtime/logged-failures.ts";
import { PlanNodes } from "../workflow/plan-nodes.ts";
import { Workflows } from "../workflow/workflow.ts";
import { boardRunId } from "./board-run.ts";

/**
 * Production card agents: each card attempt and each verification is a named session subagent
 * whose file tools and code skills are rooted at the card worktree, or at the project itself when its
 * cards run one at a time. The owner commits and integrates a worktree card's work; the sandbox
 * does not let the agent write to the repository's git data. The instructions hold for both.
 */

const cardInstructions = [
  "You carry out one card of a kanban board. Your file tools and code skills are rooted at the folder this card works in.",
  "- Do the card's work in that folder and nowhere else. Other cards may run at the same time in folders of their own.",
  "- Leave your changes in the files and do not commit, branch, merge or otherwise change git state; the owner handles that after you finish. Read-only git commands (git status, git diff, git log, git show) are fine as a sh code skill.",
  "- When a check the card needs (tests, a build, a lint) has no code skill yet, save one with save_code_skill and run it: the card's verifier cannot save skills and runs the one you saved.",
  "- When the card is done, reply with a short report of what you changed and how you checked it against the acceptance criteria.",
  "- If you cannot finish, say exactly what is missing; do not claim the card is done.",
].join("\n");

const verifierInstructions = [
  "You verify one finished card of a kanban board. Your tools are rooted at the folder holding the card's work; read its files and run its checks, but change nothing.",
  "- Check every acceptance criterion and every piece of required evidence. When a criterion depends on tests or a build, run them with the code skill that runs them; when no saved skill covers a check, report it as not run, since you cannot save skills.",
  "- Call record_card_verdict exactly once with your verdict before your final message.",
].join("\n");

const goalVerifierInstructions = [
  "You verify a whole Goal branch after every card of its kanban board was integrated, before it merges into the user's branch. Your tools are rooted at a checkout of that branch; read its files and run its checks, but change nothing.",
  "- Check that the cards together meet the Goal's outcomes and constraints. Run the project's tests or builds with the code skills that run them; when no saved skill covers a check, report it as not run, since you cannot save skills.",
  "- Call record_card_verdict exactly once with your verdict before your final message.",
].join("\n");

const outcomeVerifierInstructions = [
  "You check whether one outcome of a Goal is met, now that every card serving it is done. Your tools are rooted at the Goal's work; read its files and run its checks, but change nothing.",
  "- Judge the outcome itself, not only the cards' acceptance criteria: the cards are how the outcome was meant to be reached. When the outcome depends on tests or a build, run them with the code skill that runs them; when no saved skill covers a check, report it as not run, since you cannot save skills.",
  "- Call record_card_verdict exactly once before your final message: passed when the outcome is met, otherwise not passed with what is missing as the reason.",
].join("\n");

/** Where the MCP servers a card's agent or verifier calls look, beside their own guides. */
const mcpFolderNote =
  "- MCP servers run for the project's main folder, not the folder you work in: what they return shows the main checkout without this card's changes. Check this card's own work with your file tools.";

const listed = (title: string, items: readonly string[]) =>
  items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `- ${item}`)];

const cardText = (card: PlanStep) =>
  [
    `Card ${card.id}: ${card.title}`,
    card.description,
    ...listed("Acceptance criteria", card.acceptanceCriteria),
    ...listed("Required evidence", card.requiredEvidence ?? []),
    ...listed("Expected files", card.boundaries ?? []),
  ].join("\n");

const CardVerdictInput = Schema.Struct({
  passed: Schema.Boolean,
  evidence: Schema.Array(Schema.String).annotate({
    description: "What you checked and what showed it, one item per criterion.",
  }),
  reason: Schema.optionalKey(
    Schema.String.annotate({ description: "Why the card does not pass yet, when it does not." }),
  ),
});

const recordCardVerdict = {
  name: "record_card_verdict",
  description: "Record whether the card meets its acceptance criteria and required evidence.",
  parameters: CardVerdictInput,
} as const;

const rejected = (failure: VerdictFailure): CardVerdict => CardVerdict.Failed({ failure });

/** record_card_verdict for one verifier run, and the verdict it recorded. */
export const verdictRecorder = Effect.gen(function* () {
  const verdict = yield* Ref.make(Option.none<CardVerdict>());
  const record = (input: typeof CardVerdictInput.Type) =>
    Effect.as(
      Ref.set(
        verdict,
        Option.some<CardVerdict>(
          input.passed
            ? CardVerdict.Passed({ evidence: input.evidence })
            : rejected(
                VerdictFailure.cases.Rejected.make({
                  note: input.reason ?? input.evidence.join("; "),
                }),
              ),
        ),
      ),
      { recorded: true },
    );
  return {
    verdict: Ref.get(verdict),
    runTool: runTool({ ...recordCardVerdict, handler: record }),
  };
});

/** Only the tools `names` lists, which the planner was told the agent has. */
const allowed = (names: HashSet.HashSet<string>) => (tools: readonly RunTool[]) =>
  tools.filter(({ tool }) => HashSet.has(names, tool.name));

const make = Effect.gen(function* () {
  const subagents = yield* Subagents;
  const sessions = yield* Sessions;
  const projects = yield* Projects;
  const active = yield* ActiveProvider;
  const fileTools = yield* FileTools;
  const outsideTools = yield* OutsideTools;
  const memoryTools = yield* MemoryTools;
  const approvedTools = yield* ApprovedTools;
  const mcpServers = yield* McpServers;
  const skillTools = yield* SkillTools;
  const crypto = yield* SecureRandom.SecureRandom;
  const workflows = yield* Workflows;
  const planNodes = yield* PlanNodes;

  /**
   * The memory tools of the card's project, reading tool results of the Goal's conversation and its
   * card sessions; the name lists keep only `read_evidence` and `read_tool_result`.
   */
  const evidenceTools = (projectId: string, sessionId: string) =>
    memoryTools.toolsFor({ projectId, sessionId }, "project");

  /**
   * The memory node of the Plan version the session runs as an attempt starts: where a card
   * session's work comes from. A running card cannot be edited, so it is the version the card
   * follows. None when there is no Plan or it could not be recorded.
   */
  const planOrigin = (sessionId: string) =>
    workflows.get(sessionId).pipe(
      Effect.flatMap((state) =>
        Option.match(Option.fromNullishOr(state.plan), {
          onNone: () => Effect.succeedNone,
          onSome: (plan) =>
            Effect.map(
              planNodes.forVersion(sessionId, plan.version),
              Option.map((node) => node.id),
            ),
        }),
      ),
      fallbackLogged("Card Plan version not recorded", Option.none<string>),
    );

  /**
   * The read-only tools of the project's trusted MCP servers, which run for the project's main
   * folder. Each call asks first as the permission mode says, as in the chat. A server that fails
   * to start is left out, as in the chat.
   */
  const readOnlyMcp = (home: Project) =>
    Effect.map(mcpServers.readOnlyRunTools(home), (mcp) => ({
      tools: mcp.tools,
      gated: HashSet.union(
        gatedToolNames,
        HashSet.fromIterable(Iterable.map(mcp.tools, ({ tool }) => tool.name)),
      ),
      systemPrompts:
        mcp.tools.length === 0
          ? []
          : [`${mcpInstructionsForMode(home.permissionMode, mcp.guides)}\n${mcpFolderNote}`],
    }));

  /** The session's project as the card's tools see it, and the model the role runs on. */
  const cardSetting = Effect.fnUntraced(function* (
    sessionId: string,
    projectId: string,
    worktree: CardWorktree,
    role: AgentRole,
  ) {
    yield* sessions.get(sessionId);
    const project = yield* projects.get(projectId);
    const selection = yield* active.selectedFor(role);
    const carded = cardToolProject(project, worktree);
    // Skills as the chat offers them: a catalog of the card's own folder, or none.
    const skills: SkillToolset = yield* skillTools.toolsFor(carded, sessionId);
    return {
      project: carded,
      mcp: yield* readOnlyMcp(project),
      skills,
      selection: Option.fromNullishOr(selection),
    };
  });

  const failed = (code: AgentFailureCode): CardAgentOutcome =>
    CardAgentOutcome.Failed({ failure: CardFailure.cases.Agent.make({ code }) });
  const unavailable = <E extends { readonly _tag: string }>(error: E) =>
    Effect.as(logFailure("Kanban card agent unavailable")(error), failed("unavailable"));
  const agent = CardAgent.of({
    run: Effect.fnUntraced(
      function* (run: CardAgentRun) {
        const { project, mcp, skills, selection } = yield* cardSetting(
          run.sessionId,
          run.projectId,
          run.worktree,
          "executor",
        );
        const attempt = (chosen: Option.Option.Value<typeof selection>) =>
          Effect.gen(function* () {
            const message = [
              ...(run.continuation
                ? [
                    "You worked on this card before. Your earlier changes are already in your folder: check what is there before you change anything, and do not redo work that is done.",
                  ]
                : []),
              ...listed("Since your last run", run.notes),
              cardText(run.card),
            ].join("\n\n");
            const origin = yield* planOrigin(run.sessionId);
            const outcome = yield* subagents.runAttempt(
              {
                project,
                sessionId: run.sessionId,
                origin: Effect.succeed(origin),
                runId: boardRunId(run.goalInstanceId, run.card.id, run.attemptNo),
                selection: chosen,
                tools: [
                  ...allowed(cardAgentToolNames)([
                    ...fileTools.toolsFor(project),
                    ...outsideTools.toolsFor(project),
                    ...approvedTools.toolsFor(project, run.sessionId, "gate"),
                    ...skills.tools,
                    ...evidenceTools(run.projectId, run.sessionId),
                  ]),
                  ...mcp.tools,
                ],
                systemPrompts: [
                  ...mcp.systemPrompts,
                  ...(skills.instructions === null ? [] : [skills.instructions]),
                ],
                gated: mcp.gated,
              },
              {
                agent: `card-${run.card.id}-g${run.generation}`,
                message,
                instructions: cardInstructions,
              },
              (handle) => run.register({ runId: handle.chatRunId, traceAttemptId: handle.id }),
            );
            return Option.match(Option.fromNullishOr(outcome), {
              onNone: () => failed("not_started"),
              onSome: (ended) =>
                Match.value(ended).pipe(
                  Match.discriminatorsExhaustive("status")({
                    completed: ({ answer }) => CardAgentOutcome.Finished({ report: answer }),
                    failed: () => failed("failed"),
                    cancelled: () => failed("cancelled"),
                    interrupted: () => failed("cancelled"),
                  }),
                ),
            });
          });
        return yield* Option.match(selection, {
          onNone: () => Effect.succeed(failed("model_selection_required")),
          onSome: attempt,
        });
        // Its session, project or run records failed; the error stays in the logs only.
      },
      // A database failure is named with its kind (lock, constraint, ...), never its statement.
      Effect.catch(unavailable),
      // The card run's tool calls join this span's trace.
      Effect.withSpan("CardAgent.run"),
    ),
  });

  /** One read-only verifier run that must record a verdict. */
  const runVerifier = Effect.fnUntraced(
    function* (input: {
      readonly sessionId: string;
      readonly projectId: string;
      readonly worktree: CardWorktree;
      /** Each verification is its own run: Work Trace refuses a second invocation under one run. */
      readonly runPrefix: string;
      /**
       * Each verification also gets its own agent, named this plus the run's id. A named agent keeps
       * its conversation, so a reused verifier saw its earlier verdict and judged again without
       * recording one, while each run's recorder starts empty.
       */
      readonly agent: string;
      readonly message: string;
      readonly instructions: string;
    }) {
      const id = yield* crypto.uuidV7();
      const runId = `${input.runPrefix}:${id}`;
      const { project, mcp, skills, selection } = yield* cardSetting(
        input.sessionId,
        input.projectId,
        input.worktree,
        "verifier",
      );
      const verified = (chosen: Option.Option.Value<typeof selection>) =>
        Effect.gen(function* () {
          const recorder = yield* verdictRecorder;
          const tools: RunTool[] = [
            ...allowed(verifierToolNames)([
              ...fileTools.toolsFor(project),
              ...approvedTools.toolsFor(project, input.sessionId, "gate"),
              ...skills.tools,
              ...evidenceTools(input.projectId, input.sessionId),
            ]),
            ...mcp.tools,
            recorder.runTool,
          ];
          const origin = yield* planOrigin(input.sessionId);
          const outcome = yield* subagents.runAttempt(
            {
              project,
              sessionId: input.sessionId,
              origin: Effect.succeed(origin),
              runId,
              selection: chosen,
              tools,
              systemPrompts: [
                ...mcp.systemPrompts,
                ...(skills.instructions === null ? [] : [skills.instructions]),
              ],
              gated: mcp.gated,
            },
            {
              agent: `${input.agent}-${id}`,
              message: input.message,
              instructions: input.instructions,
            },
            () => Effect.void,
          );
          return Option.getOrElse(yield* recorder.verdict, () =>
            rejected(
              outcome?.status === "completed"
                ? VerdictFailure.cases.NoVerdict.make({})
                : VerdictFailure.cases.NotFinished.make({}),
            ),
          );
        });
      return yield* Option.match(selection, {
        onNone: () =>
          Effect.succeed(rejected(VerdictFailure.cases.ModelSelectionRequired.make({}))),
        onSome: verified,
      });
    },
    Effect.catch((error) =>
      Effect.as(
        logFailure("Kanban verifier unavailable")(error),
        rejected(VerdictFailure.cases.Unavailable.make({})),
      ),
    ),
    // The verifier run's tool calls join this span's trace.
    Effect.withSpan("CardAgent.verify"),
  );

  const verify = (input: CardVerification) =>
    runVerifier({
      sessionId: input.sessionId,
      projectId: input.projectId,
      worktree: input.worktree,
      runPrefix: boardRunId(input.goalInstanceId, input.card.id, "verify"),
      agent: `card-${input.card.id}-verify`,
      message: [cardText(input.card), `The card's agent reported:\n${input.report}`].join("\n\n"),
      instructions: verifierInstructions,
    });

  const verifyGoal = (input: GoalVerification) =>
    runVerifier({
      sessionId: input.sessionId,
      projectId: input.projectId,
      worktree: input.checkout,
      runPrefix: boardRunId(input.goalInstanceId, "goal", "verify"),
      agent: "goal-verify",
      message: [
        `Goal: ${input.goal.statement}`,
        ...listed(
          "Outcomes",
          input.goal.outcomes.map((outcome) => `${outcome.id}: ${outcome.text}`),
        ),
        ...listed("Constraints", input.goal.constraints),
        ...listed(
          "Cards integrated into the Goal branch",
          input.cards.map((card) => `${card.id}: ${card.title}`),
        ),
      ].join("\n"),
      instructions: goalVerifierInstructions,
    });

  const verifyOutcome = (input: OutcomeVerification) =>
    runVerifier({
      sessionId: input.sessionId,
      projectId: input.projectId,
      worktree: input.checkout,
      runPrefix: boardRunId(input.goalInstanceId, "outcome", input.outcome.id, "verify"),
      agent: `outcome-${input.outcome.id}-verify`,
      message: [
        `Goal: ${input.goal.statement}`,
        `Outcome to check: ${input.outcome.id}: ${input.outcome.text}`,
        ...listed("Constraints", input.goal.constraints),
        input.served === "named"
          ? "Cards that served it:"
          : "No card named this outcome. Judge it against the work of every card of the Goal, all of them done:",
        ...input.cards.map(cardText),
      ].join("\n\n"),
      instructions: outcomeVerifierInstructions,
    });

  return {
    agent,
    verifier: CardVerifier.of({ verify }),
    goalVerifier: GoalVerifier.of({ verify: verifyGoal }),
    outcomeVerifier: OutcomeVerifier.of({ verify: verifyOutcome }),
  };
});

/** Card agents and verifiers that run as session subagents in the card worktrees. */
export const subagentCardAgentsLayer = Layer.effectContext(
  Effect.map(make, ({ agent, verifier, goalVerifier, outcomeVerifier }) =>
    Context.make(CardAgent, agent).pipe(
      Context.add(CardVerifier, verifier),
      Context.add(GoalVerifier, goalVerifier),
      Context.add(OutcomeVerifier, outcomeVerifier),
    ),
  ),
).pipe(Layer.provide(NodeCrypto.layer));
