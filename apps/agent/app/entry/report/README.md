# report

## Overview

`apps/agent` 웹 앱의 `/report` 문제 제보 화면을 이루는 클라이언트 모듈 모음이다. `report-client.ts`는 `appFetch`로 `/api/reports/*` 백엔드 라우트를 Effect와 Schema로 호출한다. 이 라우트는 세션 열기, 증거 묶음 조회, 모델 진단, Discord 웹훅 전송과 결함 자동 전송 설정을 맡는다. 나머지 파일이 맡는 일은 다음과 같다.

- `report-draft`: 사용자 설명 입력과 최종 문안 생성
- `report-bundle`: 읽기 전용 증거 묶음 미리보기
- `report-diagnosis`: AI 진단 검토와 편집
- `report-delivery`: 웹훅 전송 UI
- `report-copy`: 클립보드 복사
- `report-link`: 다른 화면에서 들어오는 링크

스키마와 타입(`ReportBundle`, `ReportDiagnosis`, `ReportDeliveryStatus` 등)은 `memory-agent/definitions`에서 가져온다.

## Interface

- `makeReportClient` — fetch를 주입받아 제보 API 클라이언트 객체를 만든다(테스트용 주입 지점).
- `openReportSession` / `readReportEvidence` / `requestDiagnosis` — `appFetch`로 바인딩된 클라이언트 함수다. 각각 POST `/api/reports/sessions`, GET `/api/reports/evidence?project&session`, POST `/api/reports/diagnosis`를 호출하고 응답을 Schema로 디코드한다.
- `readDeliveryStatus` / `sendReport` / `setDefectReports` — `/api/reports/delivery`의 GET 상태 조회, `send` 명령 POST(`sendReport`는 `(report, resend)` dual), `defect_reports` 토글 POST를 맡는다.
- `ReportRequestFailed` — `Schema.TaggedError`이다. `operation`(session|evidence|diagnosis|delivery), `phase`(transport|status|response), 선택 필드 `httpStatus`를 담는다.
- `DeliveryCommand` — `Schema.TaggedUnion`이다. `send{text, evidence, resend}`와 `defect_reports{enabled}`로 이루어진 `/api/reports/delivery` 요청 본문이다.
- `copyReportText` — 주입된 클립보드 write 함수로 텍스트를 쓰고 `Promise<boolean>`을 돌려준다. dual이며 실패하면 false를 돌려준다.
- `ReportBundlePreview` — memo된 React 컴포넌트다. 증거 묶음 전체(환경, 연동·루프·결함, 칸반 보드, 타임라인 run, run 없는 항목)를 읽기 전용 접이식 패널로 보여 준다.
- `bundleGaps` / `cutTexts` — 묶음에서 수집에 실패했거나 상한으로 잘린 섹션의 문구 목록과, 잘린 원문 개수를 계산한다.
- `DeliveryOutcome` — `Data.TaggedEnum`이다. idle, sending, delivered, duplicate, uncertain_duplicate, failed 상태로 이루어진 전송 진행 상태다.
- `deliveryFailure` / `deliveryFailureText` / `deliveryOutcomeText` — 전송 오류를 HTTP 상태코드로 `ReportDeliveryFailure | "request_failed"`에 매핑하고, 실패 사유와 상태를 한국어 문구로 바꾼다.
- `ReportDelivery` — React 컴포넌트다. 웹훅 설정 조회, Discord 전송, 중복일 때 다시 보내기, 결함 자동 전송 체크박스를 제공한다.
- `DiagnosisState` / `DiagnosisText` / `diagnosisText` — 진단 수명주기(idle, running, ready{diagnosis, included}, failed)와, 그 상태를 최종 문안에 들어갈 형태(none, failed, included)로 바꾸는 변환이다.
- `diagnosisFailure` / `diagnosisFailureText` — 진단 오류를 상태코드로 `ReportDiagnosisFailure | "request_failed"`에 매핑하고 한국어 문구로 바꾼다.
- `ReportDiagnosisReview` — React 컴포넌트다. 진단 요청 버튼, 진행·실패 표시, 요약·관측·가설 편집과 항목 빼기, 문안 포함 여부 체크를 제공한다.
- `ReportFields` / `DraftEvidence` — 사용자 설명 필드(symptom, expected, actual) 타입과, 증거 상태 TaggedEnum(none, failed, collected{bundle})이다.
- `reportText` — 사용자 설명, AI 진단, 증거 묶음 요약을 합쳐 마크다운 제보 문안 문자열을 만든다.
- `shareableText` — dual이다. 문안 뒤에 증거 묶음 JSON 전체를 붙여 복사·저장용 텍스트를 만든다.
- `ReportDraft` — React 컴포넌트다. 사용자 설명 textarea 3개와 편집 가능한 최종 문안 textarea를 제공한다.
- `reportHref` / `ReportLink` — `/report?project&session` 링크를 만드는 dual 함수와 깃발 아이콘 링크 컴포넌트다.
- 하위 디렉터리 없음

## Invariants

- 거절된 응답은 상태코드만 보관하고 body를 읽지 않는다(`ReportRequestFailed` 주석, delivery·diagnosis 매핑 주석). 서버 라우트가 사유마다 상태코드 하나를 배정한다는 전제를 따른다.
- 전송 매핑은 409=`not_configured`, 503=`invalid_webhook_url`, 413=`too_large`, 423=`in_progress`, 429=`rate_limited`, 410=`webhook_rejected`, 422=`payload_rejected`, 502=`discord_unavailable`, 504=`uncertain`이다. 진단 매핑은 503=`model_unavailable`, 502=`model_failed`, 422=`invalid_answer`이다. 서버 라우트와 이 표가 맞아야 한다.
- 매핑에 없는 상태코드와 transport·response 실패는 `request_failed`가 된다. `SchemaError`는 진단에서 `invalid_answer`, 전송에서 `request_failed`로 매핑된다.
- `deliveryFailureText`와 `diagnosisFailureText`는 `satisfies Record<...Failure | "request_failed", string>`로 모든 사유를 빠짐없이 다뤄야 한다.
- `request`는 `Effect.abortSignal`과 `Effect.scoped`로 fetch에 signal을 넘긴다. 따라서 fiber를 interrupt하면 HTTP 요청도 중단된다.
- `ReportDelivery`의 상태 조회, 전송, 결함 토글은 `task` ref 하나를 공유한다. 새 작업을 시작하면 이전 fiber를 interrupt하고, 언마운트할 때도 interrupt한다.
- '그래도 다시 보내기'(`resend=true`)는 결과가 `duplicate`나 `uncertain_duplicate`일 때만 노출된다. `sending` 동안에는 전송 버튼이 비활성화된다.
- 웹훅 전송에서는 검토된 문안이 메시지 본문이고, 증거 묶음 전체가 JSON 첨부 파일이다. 첨부 파일 이름은 `context-agent-evidence.json`이다. `shareableText`는 붙여넣은 제보에도 웹훅 첨부와 같은 증거가 담기도록 묶음 JSON 전체를 덧붙인다.
- AI 진단 출력은 사용자 설명·증거와 섹션을 분리한다. 가설에는 '검증되지 않은 추정' 라벨을 붙이고, 관측은 `evidenceIds`를 근거로 표기한다. 사용자 설명 섹션에는 'AI 진단 아님' 라벨이 붙는다.
- 진단이 어떤 상태든 일반 제보 전송은 계속 가능하다(`DiagnosisState` 주석). 진단을 다시 요청하면 편집한 내용이 사라진다(UI 문구).
- 증거 미리보기는 읽기 전용이며 사용자는 항목을 고르지 않는다. 설명을 입력할 때마다 페이지가 다시 렌더되므로 `ReportBundlePreview`는 memo로 유지한다. 접힌 `Fold` 패널은 마운트하지 않는다.
- 문안 요약은 실패 run 중 마지막 5개, 결함 중 앞 5개만 담는다(`recentFailures = 5`). 전체 내용은 첨부로 간다.
- `reportHref`는 projectId가 truthy가 아니면 `/report`만 돌려준다. session 쿼리는 project가 있을 때만 붙는다.
- `copyReportText`는 클립보드 실패를 `ClipboardWriteFailed`로 잡아 false로 바꾸며 예외를 던지지 않는다. 이 함수는 Promise 경계 함수로, 내부에서 `Effect.runPromise`를 호출한다.

## Side Effects

- 네트워크: `appFetch`(`../shared/backend-restart`)로 로컬 백엔드를 호출한다. 대상은 POST `/api/reports/sessions`, GET `/api/reports/evidence`(cache no-store), POST `/api/reports/diagnosis`, GET·POST `/api/reports/delivery`이다. 서버는 전송 POST를 받으면 Discord 웹훅 메시지를 보내거나 결함 자동 전송 설정을 바꾼다.
- `ReportDelivery`는 React 컴포넌트 안에서 `Effect.runFork`로 fiber를 띄우고 `Fiber.interrupt`로 중단한다.
- 클립보드: `copyReportText`가 호출자가 넘긴 클립보드 write 함수를 호출한다.
- `ReportBundlePreview`는 렌더할 때마다 `JSON.stringify`와 `TextEncoder`로 묶음 크기를 계산한다(순수 계산이지만 렌더 비용이 든다).

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
