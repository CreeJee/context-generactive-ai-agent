import { i18n } from "@lingui/core";
import { ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Data, Function as EffectFunction } from "effect";
import { BundleEvent, runHasFailure, runPlace, type ReportBundle } from "memory-agent/definitions";
import { bundleGaps } from "./report-bundle";
import { DiagnosisText, diagnosisFailureReason } from "./report-diagnosis";

export interface ReportFields {
  symptom: string;
  expected: string;
  actual: string;
}

/** The evidence a draft describes: none was asked for (no session), it failed, or the bundle. */
export type DraftEvidence = Data.TaggedEnum<{
  none: {};
  failed: {};
  collected: { readonly bundle: ReportBundle };
}>;
export const DraftEvidence = Data.taggedEnum<DraftEvidence>();

const recentFailures = 5;

/** A few lines on the bundle for the draft itself; the bundle travels whole as an attachment. */
const evidenceLines = DraftEvidence.$match({
  none: () => [t`첨부된 증거 없음. 위 설명만으로 제보합니다.`],
  failed: () => [t`증거 묶음을 수집하지 못했습니다. 위 설명만으로 제보합니다.`],
  collected: ({ bundle }) => {
    const failing = bundle.timeline.items.filter(runHasFailure).slice(-recentFailures);
    const { release, platform, runtime, provider, model } = bundle.environment;
    return [
      t`전체 내용: 첨부 context-agent-evidence.json (세션 #${ph({ session: bundle.session.ref })}, run ${ph({ runs: bundle.timeline.items.length })}/${ph({ runCount: bundle.session.runCount })}개)`,
      t`환경: ${release} · ${platform} · ${runtime} · 모델 ${ph({ provider: provider ?? "?" })}/${ph({ model: model ?? "?" })}`,
      ...failing.map((run) => {
        const calls = run.events.flatMap((event) =>
          BundleEvent.guards.ToolCall(event) && event.result?.ok === false
            ? [`${runPlace(run)}/call-${event.seq} ${event.name ?? "?"}`]
            : [],
        );
        const code =
          run.error?.code ?? t({ message: "코드 없음", comment: "A run error without a code" });
        return `- ${runPlace(run)} ${run.status}${run.error === null ? "" : ` ${t`(오류 ${code})`}`}${calls.length > 0 ? `; ${t`실패한 도구 ${ph({ calls: calls.join(", ") })}`}` : ""}`;
      }),
      ...bundle.defects.items
        .slice(0, recentFailures)
        .map(({ tag, location, count }) => `- ${t`결함 ${tag} @ ${location} ×${count}`}`),
      ...bundleGaps(bundle).map((gap) => `- ${gap}`),
    ];
  },
});

export function reportText({
  fields,
  createdAt,
  evidence = DraftEvidence.none(),
  diagnosis = DiagnosisText.none(),
}: {
  readonly fields: ReportFields;
  readonly createdAt: string;
  readonly evidence?: DraftEvidence;
  readonly diagnosis?: DiagnosisText;
}): string {
  const unwritten = t`(작성하지 않음)`;
  return [
    t`# Context Agent 문제 제보`,
    t`작성 시각: ${createdAt}`,
    "",
    t`## 사용자 설명 (AI 진단 아님)`,
    t`증상: ${ph({ symptom: fields.symptom.trim() || unwritten })}`,
    t`기대한 동작: ${ph({ expected: fields.expected.trim() || unwritten })}`,
    t`실제 동작: ${ph({ actual: fields.actual.trim() || unwritten })}`,
    "",
    ...diagnosisLines(diagnosis),
    "",
    t`## 증거 묶음 요약`,
    ...evidenceLines(evidence),
  ].join("\n");
}

/**
 * Text for copying or saving: the draft followed by the whole bundle, so a pasted report carries
 * the same evidence the webhook attaches.
 */
export const shareableText: {
  (evidence: DraftEvidence): (text: string) => string;
} & typeof shareableTextBody = EffectFunction.dual(2, shareableTextBody);
function shareableTextBody(text: string, evidence: DraftEvidence): string {
  return DraftEvidence.$match(evidence, {
    none: () => text,
    failed: () => text,
    collected: ({ bundle }) =>
      `${text}\n\n${t`## 증거 묶음 (context-agent-evidence.json)`}\n${JSON.stringify(bundle, null, 2)}\n`,
  });
}

/** Model output stays apart from the user's text and evidence, with guesses labelled as such. */
const diagnosisLines = DiagnosisText.$match({
  none: () => [t`AI 진단: 수행하지 않음`],
  failed: (failed) => {
    const reason = i18n._(diagnosisFailureReason[failed.reason]);
    return [t`AI 진단: 실패 (${reason}). 이 제보는 사용자 설명과 증거 묶음뿐입니다.`];
  },
  included: ({ diagnosis }) => {
    const { summary, observations, hypotheses } = diagnosis;
    const none = t({ message: "없음", comment: "Report line for an empty diagnosis section" });
    return [
      t`## AI 진단 요약 (사용자가 검토함)`,
      summary.trim() || `- ${none}`,
      "",
      t`## AI 진단: 관측 (증거 묶음에서 확인)`,
      ...(observations.length > 0
        ? observations.map(
            (item) => `- ${item.text} (${t`근거: ${ph({ ids: item.evidenceIds.join(", ") })}`})`,
          )
        : [`- ${none}`]),
      "",
      t`## AI 진단: 가설 (검증되지 않은 추정)`,
      ...(hypotheses.length > 0 ? hypotheses.map((item) => `- ${item.text}`) : [`- ${none}`]),
    ];
  },
});

export function ReportDraft({
  fields,
  onChange,
  text,
  onTextChange,
}: {
  fields: ReportFields;
  onChange: (fields: ReportFields) => void;
  text: string;
  onTextChange: (text: string) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-5">
      <section
        className="space-y-3"
        aria-label={t({
          message: "문제 설명",
          comment: "Accessible name of the section where the user describes the problem",
        })}
      >
        <label className="block text-sm font-medium" htmlFor="report-symptom">
          <Trans>어떤 문제가 있었나요?</Trans>
        </label>
        <textarea
          id="report-symptom"
          className="min-h-28 w-full rounded-md border bg-background p-3 text-sm"
          value={fields.symptom}
          onChange={(event) => onChange({ ...fields, symptom: event.target.value })}
          placeholder={t`예: 승인 창이 계속 나타나고 채팅을 이어갈 수 없습니다.`}
        />
        <label className="block text-sm font-medium" htmlFor="report-expected">
          <Trans>기대한 동작 (선택)</Trans>
        </label>
        <textarea
          id="report-expected"
          className="min-h-16 w-full rounded-md border bg-background p-3 text-sm"
          value={fields.expected}
          onChange={(event) => onChange({ ...fields, expected: event.target.value })}
        />
        <label className="block text-sm font-medium" htmlFor="report-actual">
          <Trans>실제 동작 (선택)</Trans>
        </label>
        <textarea
          id="report-actual"
          className="min-h-16 w-full rounded-md border bg-background p-3 text-sm"
          value={fields.actual}
          onChange={(event) => onChange({ ...fields, actual: event.target.value })}
        />
      </section>
      <section
        className="space-y-2"
        aria-label={t({
          message: "제보 문안",
          comment: "Accessible name of the section with the final report text",
        })}
      >
        <label htmlFor="report-preview" className="block text-sm font-medium">
          <Trans>최종 제보 문안: 전송·복사·저장 전에 민감정보를 확인하고 편집해 주십시오.</Trans>
        </label>
        <textarea
          id="report-preview"
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          className="min-h-60 w-full rounded-md border bg-background p-3 font-mono text-xs"
        />
      </section>
    </div>
  );
}
