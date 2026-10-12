import type { Schema } from "effect";
import type { ReportDiagnosis, ReportDiagnosisFailure } from "memory-agent/definitions";
import type { ReportRequestFailed } from "./report-client";

/** The diagnosis lifecycle on the report page. Every state still allows sending the plain report. */
export type DiagnosisState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "ready"; readonly diagnosis: ReportDiagnosis; readonly included: boolean }
  | { readonly status: "failed"; readonly reason: ReportDiagnosisFailure | "request_failed" };

/** What the final report says about the diagnosis. */
export type DiagnosisText =
  | { readonly status: "none" }
  | { readonly status: "failed"; readonly reason: ReportDiagnosisFailure | "request_failed" }
  | { readonly status: "included"; readonly diagnosis: ReportDiagnosis };

export function diagnosisText(state: DiagnosisState): DiagnosisText {
  switch (state.status) {
    case "idle":
    case "running":
      return { status: "none" };
    case "failed":
      return { status: "failed", reason: state.reason };
    case "ready":
      return state.included
        ? { status: "included", diagnosis: state.diagnosis }
        : { status: "none" };
  }
}

export const diagnosisFailureText = {
  model_unavailable: "선택한 모델을 쓸 수 없어요(로그인·모델 선택을 확인하세요)",
  model_failed: "모델 호출이 실패했거나 시간이 초과됐어요",
  invalid_answer: "모델 응답을 진단 형식으로 읽지 못했어요",
  request_failed: "진단 요청이 실패했어요",
} satisfies Record<ReportDiagnosisFailure | "request_failed", string>;

export function diagnosisFailure(
  error: ReportRequestFailed | Schema.SchemaError,
): ReportDiagnosisFailure | "request_failed" {
  switch (error._tag) {
    case "SchemaError":
      return "invalid_answer";
    case "ReportRequestFailed":
      // The diagnosis route assigns one status code per reason; the rejected body is never read.
      switch (error.httpStatus) {
        case 503:
          return "model_unavailable";
        case 502:
          return "model_failed";
        case 422:
          return "invalid_answer";
        default:
          return "request_failed";
      }
  }
}

function EditableList({
  title,
  items,
  cite,
  onChange,
}: {
  title: string;
  items: readonly { text: string; evidenceIds?: readonly string[] }[];
  cite: boolean;
  onChange: (index: number, text: string | null) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{title}</legend>
      {items.length === 0 && <p className="text-xs text-muted-foreground">없음</p>}
      {items.map((item, index) => (
        <div key={index} className="space-y-1">
          <textarea
            aria-label={`${title} ${index + 1}`}
            className="min-h-14 w-full rounded-md border bg-background p-2 text-sm"
            value={item.text}
            onChange={(event) => onChange(index, event.target.value)}
          />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {cite && item.evidenceIds && <span>근거: {item.evidenceIds.join(", ")}</span>}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => onChange(index, null)}
            >
              이 항목 빼기
            </button>
          </div>
        </div>
      ))}
    </fieldset>
  );
}

/** Lets the user review and edit the model's diagnosis before it enters the report. */
export function ReportDiagnosisReview({
  state,
  onRequest,
  onChange,
}: {
  state: DiagnosisState;
  onRequest: () => void;
  onChange: (state: DiagnosisState) => void;
}) {
  switch (state.status) {
    case "idle":
      return (
        <div className="space-y-1">
          <button type="button" onClick={onRequest} className="rounded-md border px-3 py-2 text-sm">
            내 모델로 진단 받기 (선택)
          </button>
          <p className="text-xs text-muted-foreground">
            작성한 설명과 포함한 증거만 선택한 모델에 보냅니다. 진단 없이도 제보할 수 있습니다.
          </p>
        </div>
      );
    case "running":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          진단 중입니다. 기다리는 동안에도 제보문을 복사·저장·전송할 수 있습니다.
        </p>
      );
    case "failed":
      return (
        <div className="space-y-1 text-sm">
          <p role="status">
            진단 실패: {diagnosisFailureText[state.reason]}. 제보문에는 사용자 설명과 선택한 증거만
            들어갑니다.
          </p>
          <button type="button" onClick={onRequest} className="text-primary underline">
            다시 진단 받기
          </button>
        </div>
      );
    case "ready": {
      const { diagnosis } = state;
      const edit = (next: ReportDiagnosis) => onChange({ ...state, diagnosis: next });
      return (
        <div className="space-y-3 rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={state.included}
              onChange={(event) => onChange({ ...state, included: event.target.checked })}
            />
            제보문에 AI 진단 포함
          </label>
          <EditableList
            title="관측 (증거에서 확인)"
            items={diagnosis.observations}
            cite
            onChange={(index, text) =>
              edit({
                ...diagnosis,
                observations:
                  text === null
                    ? diagnosis.observations.filter((_, at) => at !== index)
                    : diagnosis.observations.map((item, at) =>
                        at === index ? { ...item, text } : item,
                      ),
              })
            }
          />
          <EditableList
            title="가설 (검증되지 않음)"
            items={diagnosis.hypotheses}
            cite={false}
            onChange={(index, text) =>
              edit({
                ...diagnosis,
                hypotheses:
                  text === null
                    ? diagnosis.hypotheses.filter((_, at) => at !== index)
                    : diagnosis.hypotheses.map((item, at) => (at === index ? { text } : item)),
              })
            }
          />
          <button type="button" onClick={onRequest} className="text-sm text-primary underline">
            다시 진단 받기 (편집 내용 삭제)
          </button>
        </div>
      );
    }
  }
}
