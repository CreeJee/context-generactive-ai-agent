import { toolDefinition, type AnyServerTool } from "@tanstack/ai";
import { Context, Effect, HashSet, Layer, Option, Ref, Schema } from "effect";
import { ActiveProvider } from "../providers/active-provider.ts";
import { Projects } from "../projects/projects.ts";
import { Sessions } from "../sessions/sessions.ts";
import { Subagents } from "../subagents/subagents.ts";
import { ApprovedTools } from "../tools/approved.ts";
import { gatedToolNames } from "../tools/definitions.ts";
import { FileTools } from "../tools/files.ts";
import { OutsideTools } from "../tools/outside.ts";
import { toToolSchema } from "../tools/schema.ts";
import type { PlanStep } from "../workflow/workflow.ts";
import {
  CardAgent,
  CardVerifier,
  GoalVerifier,
  type CardAgentOutcome,
  type CardVerdict,
  type CardVerification,
  type GoalVerification,
} from "./card-agent.ts";
import { cardToolProject, type CardWorktree } from "./worktree.ts";
import type { AgentFailureCode, VerdictFailure } from "./failures.ts";

/**
 * Production card agents: each card attempt and each verification is a named session subagent
 * whose file and shell tools are rooted at the card worktree. The owner commits and integrates
 * the card's work; the sandbox does not let the agent write to the repository's git data.
 */

const cardInstructions = [
  "You carry out one card of a kanban board. Your file and shell tools are rooted at the card's own git worktree.",
  "- Do the card's work in that worktree and nowhere else. Other cards run in other worktrees at the same time.",
  "- Do not commit, branch, merge or otherwise change git state; the owner commits your work when you finish. Read-only git commands (git status, git diff, git log, git show) are fine.",
  "- When the card is done, reply with a short report of what you changed and how you checked it against the acceptance criteria.",
  "- If you cannot finish, say exactly what is missing; do not claim the card is done.",
].join("\n");

const verifierInstructions = [
  "You verify one finished card of a kanban board. Your tools are rooted at the card's git worktree; read its files and run its checks, but change nothing.",
  "- Check every acceptance criterion and every piece of required evidence. Run the project's tests or builds when a criterion depends on them.",
  "- Call record_card_verdict exactly once with your verdict before your final message.",
].join("\n");

const goalVerifierInstructions = [
  "You verify a whole Goal branch after every card of its kanban board was integrated, before it merges into the user's branch. Your tools are rooted at a checkout of that branch; read its files and run its checks, but change nothing.",
  "- Check that the cards together meet the Goal's outcomes and constraints. Run the project's tests or builds.",
  "- Call record_card_verdict exactly once with your verdict before your final message.",
].join("\n");

const listed = (title: string, items: readonly string[]) =>
  items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `- ${item}`)];

const cardText = (card: PlanStep) =>
  [
    `Card ${card.id}: ${card.title}`,
    card.description,
    ...listed("Acceptance criteria", card.acceptanceCriteria),
    ...listed("Required evidence", card.requiredEvidence ?? []),
    ...listed("Expected files", card.boundaries ?? []),
    ...(card.outcome === undefined ? [] : [`Outcome: ${card.outcome}`]),
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

const readToolNames = HashSet.fromIterable(["list_files", "search_files", "read_file"]);
const checkToolNames = HashSet.fromIterable(["run_skill"]);

const make = Effect.gen(function* () {
  const subagents = yield* Subagents;
  const sessions = yield* Sessions;
  const projects = yield* Projects;
  const active = yield* ActiveProvider;
  const fileTools = yield* FileTools;
  const outsideTools = yield* OutsideTools;
  const approvedTools = yield* ApprovedTools;

  /** The session's project as the card's tools see it, and the model the session uses. */
  const cardSetting = Effect.fnUntraced(function* (
    sessionId: string,
    projectId: string,
    worktree: CardWorktree | null,
  ) {
    yield* sessions.get(sessionId);
    const project = yield* projects.get(projectId);
    const selection = yield* active.selected;
    return {
      project: worktree === null ? project : cardToolProject(project, worktree),
      selection: Option.fromNullishOr(selection),
    };
  });

  const failed = (code: AgentFailureCode): CardAgentOutcome => ({
    _tag: "Failed",
    failure: { _tag: "Agent", code },
  });
  const rejected = (failure: VerdictFailure): CardVerdict => ({ _tag: "Failed", failure });

  const agent = CardAgent.of({
    run: (run) =>
      Effect.gen(function* () {
        const { project, selection } = yield* cardSetting(
          run.sessionId,
          run.projectId,
          run.worktree,
        );
        if (Option.isNone(selection)) return failed("model_selection_required");
        const message = [
          ...(run.continuation
            ? [
                "You worked on this card before and were cut off. Your earlier changes are already in the worktree: check what is there before you change anything, and do not redo work that is done.",
              ]
            : []),
          ...listed("The orchestrator changed the card since your last run", run.notes),
          cardText(run.card),
        ].join("\n\n");
        const outcome = yield* subagents.runAttempt(
          {
            project,
            sessionId: run.sessionId,
            runId: `kanban:${run.goalInstanceId}:${run.card.id}:${run.attemptNo}`,
            selection: selection.value,
            tools: [
              ...(yield* fileTools.forProject(project)),
              ...(yield* outsideTools.forProject(project)),
              ...(yield* approvedTools.forProject(project, "gate")),
            ],
            systemPrompts: [],
            gated: gatedToolNames,
          },
          {
            agent: `card-${run.card.id}-g${run.generation}`,
            message,
            instructions: cardInstructions,
          },
          (handle) => run.register({ runId: handle.chatRunId, traceAttemptId: handle.id }),
        );
        if (outcome === null) return failed("not_started");
        switch (outcome.status) {
          case "completed":
            return { _tag: "Finished", report: outcome.answer } satisfies CardAgentOutcome;
          case "failed":
            return failed("failed");
          case "cancelled":
          case "interrupted":
            return failed("cancelled");
        }
        // Its session, project or run records failed; the error stays in the logs only.
      }).pipe(
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning("Kanban card agent unavailable", { error: error._tag }),
            failed("unavailable"),
          ),
        ),
        // The card run's tool calls join this span's trace.
        Effect.withSpan("CardAgent.run"),
      ),
  });

  /** One read-only verifier run that must record a verdict. */
  const runVerifier = (input: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly worktree: CardWorktree | null;
    readonly runId: string;
    readonly agent: string;
    readonly message: string;
    readonly instructions: string;
  }) =>
    Effect.gen(function* () {
      const { project, selection } = yield* cardSetting(
        input.sessionId,
        input.projectId,
        input.worktree,
      );
      if (Option.isNone(selection)) return rejected({ _tag: "ModelSelectionRequired" });
      const verdict = yield* Ref.make(Option.none<CardVerdict>());
      const runSync = Effect.runSyncWith(yield* Effect.context<never>());
      const record = toolDefinition({
        name: "record_card_verdict",
        description: "Record whether the card meets its acceptance criteria and required evidence.",
        inputSchema: toToolSchema(CardVerdictInput),
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      }).server((input) =>
        runSync(
          Effect.as(
            Ref.set(
              verdict,
              Option.some<CardVerdict>(
                input.passed
                  ? { _tag: "Passed", evidence: input.evidence }
                  : {
                      _tag: "Failed",
                      failure: {
                        _tag: "Rejected",
                        note: input.reason ?? input.evidence.join("; "),
                      },
                    },
              ),
            ),
            { recorded: true },
          ),
        ),
      );
      const tools: AnyServerTool[] = [
        ...(yield* fileTools.forProject(project)).filter((tool) =>
          HashSet.has(readToolNames, tool.name),
        ),
        ...(yield* approvedTools.forProject(project, "gate")).filter((tool) =>
          HashSet.has(checkToolNames, tool.name),
        ),
        record,
      ];
      const outcome = yield* subagents.runAttempt(
        {
          project,
          sessionId: input.sessionId,
          runId: input.runId,
          selection: selection.value,
          tools,
          systemPrompts: [],
          gated: gatedToolNames,
        },
        { agent: input.agent, message: input.message, instructions: input.instructions },
        () => Effect.void,
      );
      return Option.getOrElse(yield* Ref.get(verdict), () =>
        rejected(outcome?.status === "completed" ? { _tag: "NoVerdict" } : { _tag: "NotFinished" }),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning("Kanban verifier unavailable", { error: error._tag }),
          rejected({ _tag: "Unavailable" }),
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
      runId: `kanban:${input.goalInstanceId}:${input.card.id}:verify`,
      agent: `card-${input.card.id}-verify`,
      message: [cardText(input.card), `The card's agent reported:\n${input.report}`].join("\n\n"),
      instructions: verifierInstructions,
    });

  const verifyGoal = (input: GoalVerification) =>
    runVerifier({
      sessionId: input.sessionId,
      projectId: input.projectId,
      worktree: input.checkout,
      runId: `kanban:${input.goalInstanceId}:goal:verify`,
      agent: "goal-verify",
      message: [
        `Goal: ${input.goal.statement}`,
        ...listed("Outcomes", input.goal.outcomes),
        ...listed("Constraints", input.goal.constraints),
        ...listed(
          "Cards integrated into the Goal branch",
          input.cards.map((card) => `${card.id}: ${card.title}`),
        ),
      ].join("\n"),
      instructions: goalVerifierInstructions,
    });

  return {
    agent,
    verifier: CardVerifier.of({ verify }),
    goalVerifier: GoalVerifier.of({ verify: verifyGoal }),
  };
});

/** Card agents and verifiers that run as session subagents in the card worktrees. */
export const subagentCardAgentsLayer = Layer.effectContext(
  Effect.map(make, ({ agent, verifier, goalVerifier }) =>
    Context.make(CardAgent, agent).pipe(
      Context.add(CardVerifier, verifier),
      Context.add(GoalVerifier, goalVerifier),
    ),
  ),
);
