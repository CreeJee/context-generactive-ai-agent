import { Config, Crypto, DateTime, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SqlClient, SqlSchema } from "effect/sql";
import { GlobalConfig } from "../config/global-config.ts";
import { ExternalAgents } from "../external-agents/agents.ts";
import { Importer } from "../imports/importer.ts";
import { BoardHealth } from "../kanban/board-health.ts";
import { McpServers } from "../mcp/servers.ts";
import type { Project } from "../projects/projects.ts";
import { ActiveProvider } from "../providers/active-provider.ts";
import { DefectReporter } from "../runtime/defect-reporter.ts";
import { hostPlatform } from "../runtime/host-system.ts";
import { fallbackLogged } from "../runtime/logged-failures.ts";
import type { LoopHealth } from "../runtime/loop-health.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { WorkTraceStore } from "../work-trace/store.ts";
import type {
  BundleEvent,
  BundleRun,
  BundleSectionStatus,
  BundleText,
  ReportBundle,
} from "./bundle-contract.ts";

/** How much of a session a bundle holds (decided 2026-10-18). */
export const bundleLimits = {
  runs: 30,
  eventsPerRun: 60,
  textChars: 1_500,
  /** A failed tool result or run error keeps more: the cause is usually in it. */
  failureChars: 6_000,
  unlinked: 20,
} as const;

/** Local ids leave the machine only as this much of their SHA-256. */
const refLength = 12;

/** Joins texts for one redaction pass; no detector's value pattern crosses it. */
const separator = "\n\u0000␞\u0000\n";

const RunRow = Schema.Struct({
  seq: Schema.Finite,
  run_id: Schema.String,
  status: Schema.String,
  started_at: Schema.Finite,
  finished_at: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String),
  error_len: Schema.NullOr(Schema.Finite),
  error_code: Schema.NullOr(Schema.String),
});
const NodeRow = Schema.Struct({
  kind: Schema.Literals(["user", "assistant", "tool_call", "tool_result"]),
  run_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  excerpt: Schema.String,
  len: Schema.Finite,
  tool_call_id: Schema.NullOr(Schema.String),
  tool_name: Schema.NullOr(Schema.String),
  ok: Schema.NullOr(Schema.Finite),
  /** How many nodes its run has, and this one's place counting back from the newest. */
  run_total: Schema.Finite,
  back: Schema.Finite,
});
type NodeRow = typeof NodeRow.Type;
const ApprovalRow = Schema.Struct({
  run_id: Schema.String,
  status: Schema.String,
  requested_at: Schema.Finite,
  resolved_at: Schema.NullOr(Schema.Finite),
  tool: Schema.NullOr(Schema.String),
  approved: Schema.NullOr(Schema.Finite),
});
const BoardRow = Schema.Struct({ goal_instance_id: Schema.String, status: Schema.String });
const CardRow = Schema.Struct({
  goal_instance_id: Schema.String,
  card_id: Schema.String,
  failure_streak: Schema.Finite,
  replans: Schema.Finite,
  reason: Schema.NullOr(Schema.String),
});

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export const loopHealthText = (health: LoopHealth) => {
  switch (health._tag) {
    case "Healthy":
      return "Healthy";
    case "Retrying":
      return `Retrying ${health.attempt}/${health.of}`;
    case "Exhausted":
      return `Exhausted (${health.error})`;
    case "Defected":
      return "Defected";
  }
};

/** A text as read from storage: its excerpt and how long the whole was. */
interface Excerpt {
  readonly text: string;
  readonly length: number;
}

interface Section<T> {
  readonly status: BundleSectionStatus;
  readonly items: readonly T[];
  readonly truncated: boolean;
}

const section = <T>(items: readonly T[], truncated = false): Section<T> => ({
  status: items.length > 0 ? "available" : "empty",
  items,
  truncated,
});

/** A failed source marks only its own section; the bundle is still made. */
const guarded = <T, E extends { readonly _tag: string }, R>(
  load: Effect.Effect<Section<T>, E, R>,
) =>
  load.pipe(
    fallbackLogged("report_bundle_section_failed", (): Section<T> => ({
      status: "failed",
      items: [],
      truncated: false,
    })),
  );

/**
 * Collects the evidence bundle of one session (decided 2026-10-18): the environment, the
 * integrations and loops, recent defects, the session's kanban boards, and the latest runs with
 * their messages, tool calls, approvals and Work Trace tasks. Every text is redacted and cut to
 * `bundleLimits`; local ids become short hashes, runs and calls are numbered in order.
 */
export const collectReportBundle = Effect.fn("ReportBundle.collect")(function* (
  project: Project,
  session: { readonly id: string; readonly title: string | null },
) {
  const sql = yield* SqlClient.SqlClient;
  const redactor = yield* SecretRedactor;
  const crypto = yield* Crypto.Crypto;

  const ref = (id: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(id)).pipe(
      Effect.map((digest) => Hex.encode(digest).slice(0, refLength)),
      Effect.catchTag("PlatformError", () => Effect.succeed("unhashed")),
    );

  /**
   * Redacts many texts in one pass of the detectors, which is what costs; a pass that does not
   * split back into as many texts is redone one text at a time.
   */
  const hideAll = (texts: readonly Excerpt[]) =>
    Effect.gen(function* () {
      const cut = (excerpt: Excerpt, text: string): BundleText => ({
        text,
        cut: excerpt.length > excerpt.text.length,
      });
      const withheld = (excerpt: Excerpt): BundleText => ({
        text: "[비밀정보 확인 실패로 숨김]",
        cut: excerpt.length > 0,
      });
      const joined = yield* redactor
        .redactText(texts.map((excerpt) => excerpt.text).join(separator))
        .pipe(Effect.option);
      const parts = Option.map(joined, (redaction) => redaction.text.split(separator));
      if (Option.isSome(parts) && parts.value.length === texts.length)
        return texts.map((excerpt, index) => cut(excerpt, parts.value[index] ?? ""));
      return yield* Effect.forEach(texts, (excerpt) =>
        redactor.redactText(excerpt.text).pipe(
          Effect.map((redaction) => cut(excerpt, redaction.text)),
          Effect.catchTag("SecretRedactionFailed", () => Effect.succeed(withheld(excerpt))),
        ),
      );
    });

  const environment = Effect.gen(function* () {
    const release = yield* Config.String("CONTEXT_AGENT_RELEASE").pipe(
      Config.withDefault("0.0.0-dev"),
      Effect.catchTag("ConfigError", () => Effect.succeed("unknown")),
    );
    const selection = yield* (yield* ActiveProvider).selected.pipe(
      fallbackLogged("report_bundle_model_unknown", () => null),
    );
    const settings = yield* (yield* GlobalConfig).read.pipe(
      fallbackLogged("report_bundle_settings_unknown", () => null),
    );
    return {
      release,
      platform: yield* hostPlatform,
      runtime: `node ${process.versions.node}`,
      provider: selection?.provider ?? null,
      model: selection?.model ?? null,
      kanbanConcurrency: settings?.kanbanConcurrency ?? null,
    };
  });

  const integrations = guarded(
    Effect.gen(function* () {
      const mcp = yield* (yield* McpServers).overview(project);
      const agents = yield* (yield* ExternalAgents).overview(project);
      return section([
        ...mcp.servers.map((server) => ({
          kind: "mcp" as const,
          name: server.name,
          scope: server.scope,
          status: server.state.status,
          code: server.state.status === "failed" ? server.state.failure.code : null,
        })),
        ...agents.agents.map((agent) => {
          const link = agent.state.status === "trusted" ? agent.state.link : null;
          const code =
            link?.status === "retrying" || link?.status === "stopped" ? link.failure.code : null;
          return {
            kind: "agent" as const,
            name: agent.name,
            scope: agent.scope,
            status: link === null ? agent.state.status : link.status,
            code,
          };
        }),
      ]);
    }),
  );

  const loops = Effect.map((yield* Importer).watchHealth, (watch) =>
    section(watch === null ? [] : [{ loop: "imports.watch", health: loopHealthText(watch) }]),
  );

  const defects = Effect.map((yield* DefectReporter).recent, (recent) =>
    section(
      recent.map((defect) => ({
        tag: defect.tag,
        location: defect.location,
        count: defect.count,
        lastAt: iso(defect.lastAt),
      })),
    ),
  );

  const boards = guarded(
    Effect.gen(function* () {
      const health = yield* BoardHealth;
      const rows = yield* SqlSchema.findAll({
        Request: Schema.String,
        Result: BoardRow,
        execute: (id) =>
          sql`SELECT goal_instance_id, status FROM kanban_goals WHERE session_id = ${id}
            ORDER BY created_at`,
      })(session.id);
      const cards = yield* SqlSchema.findAll({
        Request: Schema.String,
        Result: CardRow,
        execute: (id) =>
          sql`SELECT c.goal_instance_id, c.card_id, c.failure_streak, c.replans, c.reason
            FROM kanban_cards c JOIN kanban_goals g ON g.goal_instance_id = c.goal_instance_id
            WHERE g.session_id = ${id} ORDER BY c.card_id`,
      })(session.id);
      const reasons = yield* hideAll(
        cards.map((card) => ({
          text: (card.reason ?? "").slice(0, bundleLimits.textChars),
          length: card.reason?.length ?? 0,
        })),
      );
      return section(
        yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            return {
              ref: yield* ref(row.goal_instance_id),
              status: row.status,
              health: loopHealthText(yield* health.get(row.goal_instance_id)),
              cards: cards.flatMap((card, index) =>
                card.goal_instance_id === row.goal_instance_id
                  ? [
                      {
                        card: card.card_id,
                        failureStreak: card.failure_streak,
                        replans: card.replans,
                        reason: card.reason === null ? null : (reasons[index]?.text ?? null),
                      },
                    ]
                  : [],
              ),
            };
          }),
        ),
      );
    }),
  );

  const runRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: RunRow,
    execute: (thread) => sql`
      SELECT * FROM (
        SELECT ROW_NUMBER() OVER (ORDER BY started_at, run_id) AS seq, run_id, status, started_at,
          finished_at, substr(error, 1, ${bundleLimits.failureChars}) AS error,
          length(error) AS error_len, error_code
        FROM chat_runs WHERE thread_id = ${thread}
      ) ORDER BY seq DESC LIMIT ${bundleLimits.runs}`,
  });

  /** Nodes of the given runs (or of none, for `null`), at most `perRun` of the newest of each. */
  const nodeRows = (runIds: readonly string[] | null, perRun: number) =>
    SqlSchema.findAll({
      Request: Schema.String,
      Result: NodeRow,
      execute: (id) => sql`
        SELECT * FROM (
          SELECT kind, run_id, created_at,
            substr(text, 1, CASE WHEN json_extract(detail, '$.ok') = 0
              THEN ${bundleLimits.failureChars} ELSE ${bundleLimits.textChars} END) AS excerpt,
            length(text) AS len,
            substr(json_extract(detail, '$.toolCallId'), 1, 128) AS tool_call_id,
            substr(json_extract(detail, '$.toolName'), 1, 128) AS tool_name,
            json_extract(detail, '$.ok') AS ok,
            COUNT(*) OVER (PARTITION BY run_id) AS run_total,
            ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY seq DESC) AS back, seq
          FROM nodes
          WHERE session_id = ${id} AND project_id = ${project.id}
            AND kind IN ('user', 'assistant', 'tool_call', 'tool_result')
            AND ${runIds === null ? sql`run_id IS NULL` : sql`run_id IN ${sql.in(runIds)}`}
        ) WHERE back <= ${perRun} ORDER BY seq`,
    })(session.id);

  const approvalRows = (runIds: readonly string[]) =>
    SqlSchema.findAll({
      Request: Schema.String,
      Result: ApprovalRow,
      execute: (thread) => sql`
        SELECT run_id, status, requested_at, resolved_at,
          substr(coalesce(json_extract(payload, '$.payload.toolName'),
            json_extract(payload, '$.toolName'),
            json_extract(payload, '$.toolCall.function.name')), 1, 128) AS tool,
          coalesce(json_extract(response, '$.approved'),
            json_extract(response, '$.response.approved')) AS approved
        FROM chat_interrupts
        WHERE thread_id = ${thread} AND run_id IN ${sql.in(runIds)}
        ORDER BY requested_at, seq`,
    })(session.id);

  /** Messages and tool calls in order; a result joins the call it answers. */
  const eventsOf = (rows: readonly NodeRow[], texts: readonly BundleText[]) => {
    const events: BundleEvent[] = [];
    const calls = new Map<string, number>();
    let callSeq = 0;
    rows.forEach((row, index) => {
      const text = texts[index] ?? { text: "", cut: false };
      switch (row.kind) {
        case "user":
        case "assistant":
          events.push({ _tag: "Message", role: row.kind, at: row.created_at, text });
          return;
        case "tool_call":
          callSeq += 1;
          if (row.tool_call_id !== null) calls.set(row.tool_call_id, events.length);
          events.push({
            _tag: "ToolCall",
            seq: callSeq,
            name: row.tool_name,
            at: row.created_at,
            input: text,
            result: null,
          });
          return;
        case "tool_result": {
          const result = { ok: row.ok === null ? null : row.ok !== 0, at: row.created_at, text };
          const at = row.tool_call_id === null ? undefined : calls.get(row.tool_call_id);
          const call = at === undefined ? undefined : events[at];
          if (call?._tag === "ToolCall") {
            events[at ?? 0] = { ...call, result };
            return;
          }
          // The call itself fell outside the bundle.
          callSeq += 1;
          events.push({
            _tag: "ToolCall",
            seq: callSeq,
            name: row.tool_name,
            at: row.created_at,
            input: { text: "", cut: true },
            result,
          });
          return;
        }
      }
    });
    return { events, calls };
  };

  const timeline = guarded(
    Effect.gen(function* () {
      const runs = (yield* runRows(session.id)).toReversed();
      if (runs.length === 0) return section<BundleRun>([]);
      const runIds = runs.map((run) => run.run_id);
      // A call and its result are two nodes: twice the events, cut again after pairing.
      const nodes = yield* nodeRows(runIds, bundleLimits.eventsPerRun * 2);
      const texts = yield* hideAll(nodes.map((node) => ({ text: node.excerpt, length: node.len })));
      const errors = yield* hideAll(
        runs.map((run) => ({ text: run.error ?? "", length: run.error_len ?? 0 })),
      );
      const approvals = yield* approvalRows(runIds).pipe(
        fallbackLogged("report_bundle_approvals_failed", () => []),
      );
      const tasks = yield* (yield* WorkTraceStore)
        .taskTree(session.id)
        .pipe(fallbackLogged("report_bundle_trace_failed", () => []));
      return section(
        yield* Effect.forEach(runs, (run, runIndex) =>
          Effect.gen(function* () {
            const own = nodes.flatMap((node, index) =>
              node.run_id === run.run_id ? [{ node, text: texts[index] }] : [],
            );
            const { events, calls } = eventsOf(
              own.map((item) => item.node),
              own.map((item) => item.text ?? { text: "", cut: false }),
            );
            const extra: BundleEvent[] = [
              ...approvals
                .filter((approval) => approval.run_id === run.run_id)
                .map((approval): BundleEvent => ({
                  _tag: "Approval",
                  status: approval.status,
                  tool: approval.tool,
                  approved: approval.approved === null ? null : approval.approved !== 0,
                  requestedAt: iso(approval.requested_at),
                  resolvedAt: approval.resolved_at === null ? null : iso(approval.resolved_at),
                })),
              ...(yield* Effect.forEach(
                tasks.filter((task) => task.parentRunId === run.run_id),
                (task) =>
                  Effect.map(ref(task.id), (taskRef): BundleEvent => {
                    const call = events[calls.get(task.parentToolCallId) ?? -1];
                    return {
                      _tag: "Trace",
                      ref: taskRef,
                      status: task.status,
                      parentToolSeq: call?._tag === "ToolCall" ? call.seq : null,
                      updatedAt: iso(task.updatedAt),
                    };
                  }),
              )),
            ];
            const timed = [...events, ...extra].toSorted((a, b) =>
              timeOf(a).localeCompare(timeOf(b)),
            );
            const total = own[0]?.node.run_total ?? 0;
            const kept = timed.slice(-bundleLimits.eventsPerRun);
            return {
              seq: run.seq,
              ref: yield* ref(run.run_id),
              status: run.status,
              startedAt: iso(run.started_at),
              finishedAt: run.finished_at === null ? null : iso(run.finished_at),
              error:
                run.error === null && run.error_code === null
                  ? null
                  : {
                      code: run.error_code,
                      detail: errors[runIndex] ?? { text: "", cut: false },
                    },
              events: kept,
              eventsCut: kept.length < timed.length || total > own.length,
            } satisfies BundleRun;
          }),
        ),
        (runs.at(0)?.seq ?? 1) > 1,
      );
    }),
  );

  const unlinked = guarded(
    Effect.gen(function* () {
      const nodes = yield* nodeRows(null, bundleLimits.unlinked);
      const texts = yield* hideAll(nodes.map((node) => ({ text: node.excerpt, length: node.len })));
      return section(eventsOf(nodes, texts).events, (nodes[0]?.run_total ?? 0) > nodes.length);
    }),
  );

  const runCount = yield* SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ count: Schema.Finite }),
    execute: (thread) => sql`SELECT COUNT(*) AS count FROM chat_runs WHERE thread_id = ${thread}`,
  })(session.id).pipe(
    Effect.map((row) => row.count),
    fallbackLogged("report_bundle_run_count_failed", () => 0),
  );
  const title =
    session.title === null
      ? null
      : ((yield* hideAll([
          { text: session.title.slice(0, 200), length: session.title.length },
        ]))[0] ?? null);

  const parts = yield* Effect.all(
    { environment, integrations, loops, defects, boards, timeline, unlinked },
    // One database and one redactor: reading sections in turn keeps other requests moving.
    { concurrency: 1 },
  );
  return {
    version: 1,
    collectedAt: DateTime.formatIso(yield* DateTime.now),
    limits: {
      runs: bundleLimits.runs,
      eventsPerRun: bundleLimits.eventsPerRun,
      textChars: bundleLimits.textChars,
      failureChars: bundleLimits.failureChars,
    },
    session: { ref: yield* ref(session.id), title, runCount },
    ...parts,
  } satisfies ReportBundle;
});

const timeOf = (event: BundleEvent) => {
  switch (event._tag) {
    case "Message":
    case "ToolCall":
      return event.at;
    case "Approval":
      return event.requestedAt;
    case "Trace":
      return event.updatedAt;
  }
};
