import { Effect, Schema } from "effect";
import type { readStructuredEvidence } from "../src/memory/evidence.ts";

type Evidence = NonNullable<Effect.Success<ReturnType<typeof readStructuredEvidence>>>;
type Excerpt = Evidence["evidenceContext"]["provenance"][number];
const encodeDetail = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const describeExcerpt = Effect.fnUntraced(function* (source: Excerpt) {
  const detail = yield* encodeDetail(source.detail);
  return `Source ${source.id} is a ${source.kind} node in project ${source.projectId}, session ${source.sessionId}, recorded at ${source.recordedAt}. Its detail is ${detail}. The original has ${source.length} UTF-16 units; this excerpt spans [${source.span.start}, ${source.span.end}) in ${source.span.unit} units. Its next offset is ${source.nextOffset}. Exact source text follows:\n${source.text}`;
});

/** Preserve every field and exact source text; vary presentation, not evidence selection. */
export const evidenceNarrative = Effect.fnUntraced(function* (pages: readonly Evidence[]) {
  const paragraphs = yield* Effect.forEach(
    pages,
    Effect.fnUntraced(function* (page) {
      const context = page.evidenceContext;
      const root = yield* describeExcerpt({
        id: page.id,
        kind: page.kind,
        projectId: page.projectId,
        sessionId: page.sessionId,
        recordedAt: page.createdAt,
        detail: page.detail,
        text: page.text,
        span: context.sourceSpan,
        nextOffset: page.nextOffset,
        length: page.length,
      });
      const provenance = yield* Effect.forEach(context.provenance, describeExcerpt, {
        concurrency: 1,
      });
      const changes = yield* Effect.forEach(
        context.changes,
        Effect.fnUntraced(function* (change) {
          const source = yield* describeExcerpt(change.source);
          return `Source ${change.source.id} has relation ${change.relation} to target ${change.targetId}, with interpretation status ${change.status}. ${source}`;
        }),
        { concurrency: 1 },
      );
      return `The read_evidence tool returned a page at offset ${page.offset}. ${root}\nIts assessment is ${context.assessment.kind}. Unconfirmed changes present: ${context.hasUnconfirmedChanges}. Provenance limited by scope: ${context.provenanceScopeLimited}. Omitted changes: ${context.omittedChanges}; omitted provenance: ${context.omittedProvenance}.\nProvenance in returned order (${provenance.length} entries):\n${provenance.join("\n\n")}\nRecorded changes in returned order (${changes.length} entries):\n${changes.join("\n\n")}`;
    }),
    { concurrency: 1 },
  );
  return paragraphs.join("\n\n");
});
