# lib

## Overview

`apps/agent/app/lib`는 에이전트 앱 프런트엔드(React UI)가 `~/lib/*` 별칭으로 가져다 쓰는 작은 공용 유틸리티 모음이다. `dates.ts`는 dayjs와 한국어 로케일로 ISO 시각 문자열을 화면 표시용 문자열로 바꾸고, `utils.ts`는 외부 `cn` 패키지의 클래스 이름 결합 함수를 다시 내보낸다. 사이드바, 채팅 패널, 설정 페이지, UI 컴포넌트가 이 함수들을 쓴다.

## Interface

- `dayAndTime` — ISO 문자열을 한국어 로케일 "M월 D일 A hh:mm" 형식(예: "9월 15일 오후 11:33")으로 바꾼다. 제목이 아직 없는 대화의 시작 시각 표시에 쓴다(sidebar, btw-panel, settings/pages/embedding).
- `timeOfDay` — ISO 문자열을 한국어 로케일 "A hh:mm" 형식(예: "오후 09:53")으로 바꾼다. 날짜를 말하지 않아도 되는 곳에서 쓴다(settings/pages/imports).
- `cn` — `cn` 패키지에서 다시 내보내는 className 결합 함수다. `~/lib/utils`로 UI 컴포넌트 여러 곳이 가져다 쓴다.

## Invariants

- `dates.ts`는 `dayjs/locale/ko.js`를 부수 효과 import로 등록한 뒤 호출마다 `.locale("ko")`를 지정한다. 한국어 오전/오후(`A`) 표기는 이 로케일 등록에 기대므로 그 import를 지우면 안 된다.
- 두 날짜 함수는 입력을 ISO 문자열로 받고, 시간대 변환 없이 dayjs 기본(실행 환경 로컬 시간대)으로 표시한다.
- 호출 측은 `~/lib/dates`, `~/lib/utils` 경로 별칭으로 가져오므로 파일 이름과 export 이름을 바꾸면 사이드바·채팅·설정 화면 import가 깨진다.

## Side Effects

- `dates.ts`를 불러오면 `dayjs/locale/ko.js`가 dayjs 전역 로케일 레지스트리에 한국어 로케일을 등록한다(모듈 로드 시 한 번). 그 밖의 DB, 파일, 네트워크 부수 효과는 없다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
