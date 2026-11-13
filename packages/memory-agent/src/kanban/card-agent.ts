import { Context, Data, type Effect } from "effect";
import type { GoalArtifact, GoalOutcome, PlanStep } from "../workflow/workflow.ts";
import type { OutcomeServed } from "../workflow/outcome-ledger.ts";
import type { KanbanStorageFailed } from "./card-attempts.ts";
import type { CardFailure, VerdictFailure } from "./failures.ts";
import type { CardWorktree } from "./worktree.ts";

/**
 * The agents a kanban card runs with. The queue handler and the orchestrator depend on these
 * contracts only; production runs them as session subagents (`subagent-card-agent.ts`), tests
 * with scripted fakes.
 */

/** One delivery of a card attempt. */
export interface CardAgentRun {
  readonly sessionId: string;
  readonly projectId: string;
  readonly goalInstanceId: string;
  readonly card: PlanStep;
  readonly attemptNo: number;
  /**
   * Where the agent's file tools and code skills are rooted: the card worktree, or the project itself
   * when the project cannot have worktrees and its cards run one at a time.
   */
  readonly worktree: CardWorktree;
  /**
   * The card ran before: the agent continues from the same worktree and conversation instead of
   * starting over. Files written earlier are already there and are not written again blindly.
   */
  readonly continuation: boolean;
  /** Changes the orchestrator applied to the card since its last run, for the agent to follow. */
  readonly notes: readonly string[];
  /** Names a new agent conversation; it changes when the card is reassigned. */
  readonly generation: number;
  /** Called once the agent run has an id and before it can call any tool. */
  readonly register: (run: {
    readonly runId: string;
    readonly traceAttemptId: string | null;
  }) => Effect.Effect<void, KanbanStorageFailed>;
}

export type CardAgentOutcome = Data.TaggedEnum<{
  Finished: { readonly report: string };
  Failed: { readonly failure: CardFailure };
}>;
export const CardAgentOutcome = Data.taggedEnum<CardAgentOutcome>();

/**
 * Runs one delivery of a card. Interrupting it stops the agent; the run's checkpoint settles
 * before the effect ends.
 */
export class CardAgent extends Context.Service<
  CardAgent,
  { readonly run: (run: CardAgentRun) => Effect.Effect<CardAgentOutcome> }
>()("memory-agent/kanban/card-agent/CardAgent") {}

export interface CardVerification {
  readonly sessionId: string;
  readonly projectId: string;
  readonly goalInstanceId: string;
  readonly card: PlanStep;
  readonly worktree: CardWorktree;
  /** What the card's agent reported for the attempt being verified. */
  readonly report: string;
}

export type CardVerdict = Data.TaggedEnum<{
  Passed: { readonly evidence: readonly string[] };
  Failed: { readonly failure: VerdictFailure };
}>;
export const CardVerdict = Data.taggedEnum<CardVerdict>();

/** Checks a finished card against its acceptance criteria and required evidence. */
export class CardVerifier extends Context.Service<
  CardVerifier,
  { readonly verify: (input: CardVerification) => Effect.Effect<CardVerdict> }
>()("memory-agent/kanban/card-agent/CardVerifier") {}

/** The Goal branch as a whole, after every card is in it. */
export interface GoalVerification {
  readonly sessionId: string;
  readonly projectId: string;
  readonly goalInstanceId: string;
  readonly goal: GoalArtifact;
  readonly cards: readonly PlanStep[];
  /** A detached checkout of the Goal branch commit being checked. */
  readonly checkout: CardWorktree;
}

/**
 * The Goal-level integration check before the Goal branch merges into the user's branch. It runs
 * again for every new Goal branch commit, such as after the user's branch was taken in.
 */
export class GoalVerifier extends Context.Service<
  GoalVerifier,
  { readonly verify: (input: GoalVerification) => Effect.Effect<CardVerdict> }
>()("memory-agent/kanban/card-agent/GoalVerifier") {}

/** A conflicted take-in of the user's branch, left in a checkout of the Goal branch. */
export interface GoalConflictResolution {
  readonly sessionId: string;
  readonly projectId: string;
  readonly goalInstanceId: string;
  readonly goal: GoalArtifact;
  /** The user's branch whose changes meet the Goal's. */
  readonly targetBranch: string;
  /** Files git left with conflict markers. */
  readonly files: readonly string[];
  /** The checkout holding the unfinished merge. */
  readonly checkout: CardWorktree;
  /** What the owner found after an earlier try in the same checkout. */
  readonly notes: readonly string[];
}

/**
 * Resolves the conflicts of taking the user's branch into the Goal branch. The owner commits the
 * merge afterwards, and the Goal-level check runs on it before the user's branch moves.
 */
export class GoalConflictResolver extends Context.Service<
  GoalConflictResolver,
  { readonly resolve: (input: GoalConflictResolution) => Effect.Effect<CardAgentOutcome> }
>()("memory-agent/kanban/card-agent/GoalConflictResolver") {}

/** One outcome of the Goal, once every card serving it is done. */
export interface OutcomeVerification {
  readonly sessionId: string;
  readonly projectId: string;
  readonly goalInstanceId: string;
  readonly goal: GoalArtifact;
  readonly outcome: GoalOutcome;
  /** Whether the cards named the outcome, or no card did and they are the whole finished Plan. */
  readonly served: OutcomeServed;
  /** The cards that serve the outcome. */
  readonly cards: readonly PlanStep[];
  /** A checkout of the Goal branch, or the project itself for a Goal without worktrees. */
  readonly checkout: CardWorktree;
}

/**
 * Whether the Goal's work meets one outcome: Passed when it does, Failed with a Rejected note when
 * it checked and found the outcome short. The verdict goes to the outcome ledger.
 */
export class OutcomeVerifier extends Context.Service<
  OutcomeVerifier,
  { readonly verify: (input: OutcomeVerification) => Effect.Effect<CardVerdict> }
>()("memory-agent/kanban/card-agent/OutcomeVerifier") {}
