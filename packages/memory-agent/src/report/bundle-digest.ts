import type { BundleEvent, BundleRun, BundleText, ReportBundle } from "./bundle-contract.ts";

/** One part of the bundle as the diagnosis model reads it, named by its place in the bundle. */
export interface DigestItem {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

/**
 * What of a bundle the diagnosis reads (decided 2026-10-18): an outline of every run, the
 * environment, and the full text around each failure, newest first. The whole bundle can be far
 * larger than a model request should be; the outline keeps the order of events in view, and the
 * failures carry the detail a cause is found in.
 */
export const digestLimits = {
  outlineChars: 8_000,
  environmentChars: 3_000,
  failureItems: 10,
  failureChars: 3_000,
} as const;

export const runPlace = (run: BundleRun) => `run-${run.seq}`;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const shown = (text: BundleText) => (text.cut ? `${text.text} [잘림]` : text.text);

const callOutcome = (ok: boolean | null | undefined) => {
  switch (ok) {
    case true:
      return "ok";
    case false:
      return "FAILED";
    case null:
      return "?";
    case undefined:
      return "no result";
  }
};

const eventLine = (event: BundleEvent): string => {
  switch (event._tag) {
    case "Message":
      return `${event.role}: ${clip(event.text.text.replace(/\s+/g, " "), 120)}`;
    case "ToolCall":
      return `call-${event.seq} ${event.name ?? "?"} → ${callOutcome(event.result?.ok)}`;
    case "Approval":
      return `approval ${event.tool ?? "?"} ${event.status}${event.approved === null ? "" : event.approved ? " approved" : " denied"}`;
    case "Trace":
      return `work trace ${event.status}`;
  }
};

const runHead = (run: BundleRun) =>
  `${runPlace(run)} ${run.status} ${run.startedAt}${run.error === null ? "" : ` error=${run.error.code ?? "unknown"}`}`;

/** A run failed, or something in it did. */
export const runHasFailure = (run: BundleRun) =>
  run.error !== null ||
  run.events.some((event) => {
    switch (event._tag) {
      case "ToolCall":
        return event.result?.ok === false;
      case "Approval":
        return event.approved === false;
      case "Message":
      case "Trace":
        return false;
    }
  });

const environmentText = (bundle: ReportBundle) => {
  const { environment } = bundle;
  return [
    `release ${environment.release} · ${environment.platform} · ${environment.runtime}`,
    `model ${environment.provider ?? "?"}/${environment.model ?? "?"} · kanban concurrency ${environment.kanbanConcurrency ?? "default"}`,
    ...bundle.integrations.items.map(
      (item) =>
        `${item.kind} ${item.name} (${item.scope}): ${item.status}${item.code === null ? "" : ` ${item.code}`}`,
    ),
    ...bundle.loops.items.map((item) => `loop ${item.loop}: ${item.health}`),
    ...bundle.boards.items.map(
      (board) =>
        `board ${board.ref} ${board.status} loop=${board.health}; ${board.cards
          .filter((card) => card.reason !== null || card.failureStreak > 0)
          .map((card) => `${card.card} fails=${card.failureStreak} ${card.reason ?? ""}`)
          .join("; ")}`,
    ),
    ...bundle.defects.items.map(
      (defect) => `defect ${defect.tag} @ ${defect.location} ×${defect.count} (${defect.lastAt})`,
    ),
  ].join("\n");
};

/** A failing run's error, the message that asked for it, and each failed call or refusal. */
const failureText = (run: BundleRun) => {
  const lastAsk = run.events.findLast((event) => event._tag === "Message" && event.role === "user");
  const parts = [
    runHead(run),
    ...(run.error === null ? [] : [`error detail: ${shown(run.error.detail)}`]),
    ...(lastAsk?._tag === "Message" ? [`user asked: ${shown(lastAsk.text)}`] : []),
    ...run.events.flatMap((event) => {
      switch (event._tag) {
        case "ToolCall":
          return event.result?.ok === false
            ? [
                `call-${event.seq} ${event.name ?? "?"} input: ${shown(event.input)}`,
                `call-${event.seq} result: ${shown(event.result.text)}`,
              ]
            : [];
        case "Approval":
          return event.approved === false ? [eventLine(event)] : [];
        case "Message":
        case "Trace":
          return [];
      }
    }),
  ];
  return parts.join("\n");
};

/** Every place in the bundle an observation may cite. */
export function bundlePlaces(bundle: ReportBundle): Set<string> {
  return new Set([
    "environment",
    "timeline",
    ...bundle.timeline.items.flatMap((run) => [
      runPlace(run),
      ...run.events.flatMap((event) =>
        event._tag === "ToolCall" ? [`${runPlace(run)}/call-${event.seq}`] : [],
      ),
    ]),
  ]);
}

export function diagnosisDigest(bundle: ReportBundle): DigestItem[] {
  const outline = bundle.timeline.items
    .map((run) => [runHead(run), ...run.events.map((event) => `  ${eventLine(event)}`)].join("\n"))
    .join("\n");
  const failing = bundle.timeline.items
    .filter(runHasFailure)
    .toReversed()
    .slice(0, digestLimits.failureItems);
  return [
    {
      id: "environment",
      label: "환경·연동·루프·결함",
      text: clip(environmentText(bundle), digestLimits.environmentChars),
    },
    {
      id: "timeline",
      label: `세션 타임라인 (run ${bundle.timeline.items.length}/${bundle.session.runCount})`,
      // The newest runs matter most: an outline over the limit loses its oldest lines.
      text:
        outline.length > digestLimits.outlineChars
          ? `…${outline.slice(outline.length - digestLimits.outlineChars + 1)}`
          : outline,
    },
    ...failing.map((run) => ({
      id: runPlace(run),
      label: `실패 주변 ${runPlace(run)}`,
      text: clip(failureText(run), digestLimits.failureChars),
    })),
  ];
}
