# profile

## Overview

`tools/profile`는 에이전트 백엔드를 개발 중에 프로파일링하는 CLI 도구다(`profile` 명령, `effect/cli` 기반). Effect span을 OTLP/JSON HTTP 또는 Effect devtools WebSocket으로 받아 NDJSON 파일에 덧붙이고, span NDJSON이나 V8 `.cpuprofile`을 텍스트 표(total/self, p50/p95, 가장 느린 경로, 소유자별 self)로 요약한다. 런타임 코드에서 import하지 않는 독립 개발 도구이며, `effect-profile` 스킬이 이 도구로 결과를 텍스트로 읽는다.

## Interface

- `main.ts` (`profile` CLI) — `NodeRuntime.runMain`으로 실행하는 진입점, 하위 명령 `collect-otlp`, `collect-devtools`, `summarize`
- `profile collect-otlp --out <file> [--port 4318] [--until-stdin-closes]` — 127.0.0.1에서 OTLP/JSON trace를 받아 span NDJSON으로 덧붙임, 플래그가 있으면 stdin이 닫힐 때 종료
- `profile collect-devtools --out <file> [--port 34437]` — Effect devtools 프로토콜(WebSocket)로 끝난 span을 받아 NDJSON으로 저장 (개발용)
- `profile summarize <file...> [--top 20]` — `.cpuprofile`로 끝나면 CPU 요약, 아니면 span NDJSON 요약을 stdout에 출력
- `SpanRecord` — span 한 줄 Schema (traceId, spanId, parentSpanId|null, name, startUnixMs, durationMs, outcome `ok|error|interrupted`, 숫자·불리언만 있는 attributes)
- `SpanLine` — `Schema.fromJsonString(SpanRecord)`, NDJSON 한 줄 인코딩·디코딩
- `SpanWriter` — `Context.Service`(키 `tools/profile/span-record/SpanWriter`), `{ file, write(records) }`, `SpanWriter.layer(file)`로 제공
- `scalarAttributes` — 속성 항목 중 유한 숫자와 불리언만 남기는 함수
- `nanosToMillis` — bigint 나노초를 밀리초 number로 변환
- `otlpCollector(port)` — `POST /v1/traces`(OTLP/JSON 디코딩 후 `SpanWriter.write`)와 `POST /v1/metrics`(받고 버림)를 띄우는 `Layer.launch` Effect, `SpanWriter` 필요
- `devtoolsCollector(port)` — `DevToolsServer.run`으로 클라이언트 큐의 Ended span만 기록하는 Effect, `SpanWriter` 필요
- `readSpans(file)` — NDJSON 파일을 읽어 빈 줄을 빼고 `SpanLine`으로 디코딩
- `summarizeSpans(spans, top)` — 이름별 total/self/count/p50/p95/max/err/int 표와 가장 느린 span 경로(바깥쪽부터) 텍스트 생성
- `readCpuProfile(file)` — `.cpuprofile` JSON을 읽어 `CpuProfile` Schema로 디코딩
- `summarizeCpuProfile(profile, root, top)` — self/total 상위 함수, VM 분류(idle/GC/program), 소유자(워크스페이스 폴더·의존성·node·vm)별 self 시간 텍스트 생성
- `workingRoot` — `Path.resolve(".")`로 현재 작업 폴더를 돌려주는 Effect

## Invariants

- `SpanRecord.attributes`는 숫자(Finite)와 불리언만 담는다. 문자열 값은 프롬프트·경로·provider 오류를 실을 수 있으므로 파일에 쓰지 않는다 (`scalarAttributes`, OTLP Schema는 초과 키를 디코딩 중에 버림).
- `SpanWriter.write`는 `Semaphore.make(1)`로 한 번에 한 쓰기만 하여 동시 배치의 줄이 섞이지 않게 한다. 빈 배열이면 쓰지 않는다.
- 두 수집기와 `summarize`는 같은 `SpanLine`(NDJSON 한 줄 = `SpanRecord` 하나) 형식을 공유한다. 형식을 바꾸면 수집기와 요약기를 함께 바꿔야 한다.
- OTLP 수집기는 `127.0.0.1`에만 바인딩한다. span은 로컬 프로파일링 데이터이고 네트워크 서비스가 아니다.
- devtools는 span을 시작 때와 끝날 때 두 번 보내므로 `Ended` 상태만 기록한다. `SpanEvent`, `MetricsSnapshot`은 버린다.
- OTLP outcome 판정: status code 2면 `error`, 아니면 `effect.fiber.interrupted === true` 속성이면 `interrupted`, 그 외 `ok` (Effect는 중단 span을 Unset status와 이 속성으로 표시). 빈 문자열 `parentSpanId`는 null로 본다.
- devtools outcome 판정: Exit 성공이면 `ok`, 원인이 interrupt뿐이면 `interrupted`, 그 외 `error`.
- `/v1/traces`의 `SchemaError`, `HttpServerError`는 400 응답으로 바꾸고 성공 시 200을 돌려준다. `/v1/metrics`는 항상 200으로 받고 버린다.
- `main.ts`는 `@effect/platform-node`의 하위 모듈만 import한다. 패키지 진입점은 NodeRedis와 그 클라이언트까지 로드하기 때문이다.
- span 요약의 self 시간은 자식 duration 합을 빼되, 자식이 동시에 돌았을 때를 위해 0 아래로 내려가지 않게 자른다.
- CPU 요약에서 timeDelta는 해당 샘플 앞의 간격이므로 각 샘플의 지속 시간은 다음 delta(없으면 평균)로 잡는다. total 시간은 재귀해도 샘플당 함수 하나를 한 번만 센다.
- `summarize`는 파일 이름이 `.cpuprofile`로 끝나면 CPU 프로파일, 아니면 span NDJSON으로 해석한다.
- `--port`는 1~65535 정수, `--top`은 0보다 큰 정수여야 한다 (Schema 검사).

## Side Effects

- 파일 시스템 쓰기: `SpanWriter`가 `--out` NDJSON 파일에 append 모드(`flag: "a"`)로 줄을 덧붙인다.
- 파일 시스템 읽기: `readSpans`, `readCpuProfile`이 입력 파일을 문자열로 읽는다.
- 네트워크: `otlpCollector`가 `127.0.0.1:<port>`(기본 4318)에 HTTP 서버를 띄운다.
- 네트워크: `devtoolsCollector`가 `<port>`(기본 34437)에 WebSocket 서버(`NodeSocketServer.layerWebSocket`)를 띄운다.
- stdin: `--until-stdin-closes`일 때 stdin을 끝까지 drain하고, 닫히면 `Effect.raceFirst`로 수집기를 끝낸다.
- 콘솔 출력: 수집 시작 메시지와 요약 텍스트를 `Console.log`로 stdout에 쓴다.
- 프로세스: `NodeRuntime.runMain`으로 Node 프로세스 수명을 관리한다. `workingRoot`는 현재 작업 디렉터리(`path.resolve(".")`)를 읽는다.

## Verification

- Run: `tsc -p tools/profile/tsconfig.json` (저장소 루트)
