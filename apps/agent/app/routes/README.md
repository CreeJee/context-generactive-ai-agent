# routes

## Overview

`apps/agent`의 React Router v7 페이지 라우트 디렉터리다. `_index.tsx`는 루트 경로에서 메인 채팅 앱(`../entry`의 `App`)을 그대로 렌더링한다. `report.tsx`는 문제 제보 페이지다. 제보 페이지는 증상 입력, 세션 증거 묶음 수집, AI 진단, 복사/파일 저장, 선택적인 Discord 웹훅 전송을 한 화면에서 묶는다. 실제 네트워크 호출과 문안 생성은 `apps/agent/app/entry/report` 모듈이 맡고, HTTP 리소스 라우트는 하위 `api/`에 있다.

## Interface

- `_index.tsx` `default Agent` — 루트 페이지 컴포넌트다. `../entry`의 `<App />`만 렌더링한다.
- `_index.tsx` `meta` — 제목 `Agent`, description `Run!` 메타를 돌려준다.
- `report.tsx` `default ReportPage` — 문제 제보 페이지다. 쿼리 `?project=&session=`가 모두 있으면 분석 세션을 열고 증거 묶음을 수집한다. 없으면 증상 설명만으로 제보한다.
- `report.tsx` `meta` — 제목 `문제 제보 · Context Agent`를 돌려준다.
- `EvidenceState` (모듈 내부, `Data.taggedEnum`) — `none | loading | failed | collected{bundle: ReportBundle}` 상태다. `draftEvidence`가 이 상태를 `DraftEvidence`로 바꾼다(`loading`은 `none`으로 바뀐다).
- 의존 모듈 — `../entry/report/report-client`(`openReportSession`, `readReportEvidence`, `requestDiagnosis`), `report-draft`(`ReportDraft`, `reportText`, `shareableText`, `DraftEvidence`), `report-diagnosis`(`ReportDiagnosisReview`, `DiagnosisState`, `diagnosisText`, `diagnosisFailure`), `report-bundle`(`ReportBundlePreview`), `report-copy`(`copyReportText`), `report-delivery`(`ReportDelivery`), 타입 `memory-agent/definitions`의 `ReportBundle`
- [`api/`](./api/README.md) — `/api/...` 리소스 라우트 모음이다. 각 파일은 `loader`(GET)와 `action`(POST)만 export하는 얇은 HTTP 어댑터다.

## Invariants

- 분석 세션 열기와 증거 수집은 URL 쿼리에 `project`와 `session`이 모두 truthy일 때만 실행된다(`isTruthy`로 검사).
- `Effect.runFork`로 띄운 fiber마다 effect cleanup이나 unmount에서 `Fiber.interrupt`로 중단한다. `sessionRetry`, `evidenceRetry` 값이 바뀌면 이전 작업을 중단하고 다시 실행한다.
- 새 진단을 요청하면 먼저 실행 중인 진단 fiber(`diagnosisTask` ref)를 중단한다. unmount 때도 그 fiber를 중단한다.
- 진단 요청 입력은 잘라서 보낸다. `symptom`은 4,000자까지, `expected`와 `actual`은 각각 2,000자까지 보낸다.
- 사용자가 문안을 직접 편집하면(`editedText !== null`) 그 문안이 우선한다. 증상, 진단, 증거가 바뀌어도 자동으로 반영되지 않는다. 사용자가 다시 생성을 눌러야 `null`로 돌아간다.
- 공유 텍스트(`shareableText`)는 복사나 저장을 누를 때만 만든다. 주석에 따르면 증거 묶음이 수백 KB일 수 있기 때문이다.
- 제보는 자동으로 전송하지 않는다. 사용자가 직접 누를 때만 Discord 웹훅으로 보낸다. 페이지 문구가 이를 밝힌다.
- 작성 시각(`createdAt`)은 처음에 `작성 중`으로 시작한다. mount 후 `useEffect`에서 `DateTime.nowUnsafe()`와 `ko-KR` 형식으로 채운다.
- 증거 수집이나 분석 세션 열기가 실패해도 제보문 작성, 복사, 저장은 계속 쓸 수 있다. 실패하면 재시도 버튼이 나타난다.

## Side Effects

- 네트워크: `openReportSession`이 원본 세션을 기준으로 별도 분석 세션을 연다. 서버 상태가 바뀐다.
- 네트워크: `readReportEvidence`가 세션 증거 묶음을 읽고, `requestDiagnosis`가 AI 진단을 요청한다.
- 네트워크(하위 컴포넌트): `ReportDelivery`가 사용자가 직접 누를 때 Discord 웹훅으로 보낸다.
- `window.location.search`를 읽는다.
- `navigator.clipboard.writeText`로 클립보드에 쓴다.
- `URL.createObjectURL`과 `Blob`, 임시 `<a>` 클릭으로 `context-agent-report.txt`를 내려받는다. `Effect.sleep("1 second")` 타이머 뒤에 `URL.revokeObjectURL`을 호출한다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
