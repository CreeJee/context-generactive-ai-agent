import { Context, type Effect } from "effect";
import type { GoalArtifact, PlanStep } from "../workflow/workflow.ts";
import type { KanbanStorageFailed } from "./card-attempts.ts";
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
   * The card worktree the agent's file and shell tools are rooted at, or none when the project
   * cannot have worktrees and its cards run one at a time in the project itself.
   */
  readonly worktree: CardWorktree | null;
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

export type CardAgentOutcome =
  | { readonly _tag: "Finished"; readonly report: string }
  /** `code` is an error tag or status word, never provider text. */
  | { readonly _tag: "Failed"; readonly code: string };

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
  readonly worktree: CardWorktree | null;
  /** What the card's agent reported for the attempt being verified. */
  readonly report: string;
}

export type CardVerdict =
  | { readonly _tag: "Passed"; readonly evidence: readonly string[] }
  | { readonly _tag: "Failed"; readonly reason: string };

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
