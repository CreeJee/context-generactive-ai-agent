---
name: effect-profile
description: Profile the agent backend in this repository — collect Effect spans (OTLP or Effect devtools) and V8 CPU profiles, then read them as text with tools/profile. Use when asked why something is slow, to find hot paths or slow steps, to compare performance before and after a change, or to profile a worker.
---

# Effect 프로파일링

에이전트 백엔드의 느린 단계와 hotspot을 텍스트로 읽는 절차다. 두 가지 신호를 함께 본다.

- **Effect span**: 어느 도메인 단계(`Effect.fn("...")`, `Effect.withSpan`)가 시간을 쓰는지.
- **V8 CPU 프로파일**: 그 안에서 어느 함수와 패키지가 CPU를 쓰는지.

도구는 `tools/profile/main.ts` 하나다. 모든 명령은 저장소 루트에서 실행한다.

## 1. span 수집 (기본: OTLP)

수집기를 먼저 띄운다. 결과 파일은 스크래치 폴더처럼 저장소 밖에 둔다.

```sh
node tools/profile/main.ts collect-otlp --port 4318 --out <스크래치>/spans.ndjson
```

백엔드는 표준 OTEL 변수로 켠다. 변수가 없으면 아무것도 내보내지 않는다.

```sh
OTEL_TRACES_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
vp run dev
```

- span은 5초마다, 그리고 런타임 종료 때 한 번 더 내보낸다. 측정한 동작을 끝낸 뒤 5초 이상 기다리거나 백엔드를 정상 종료한 다음 요약한다.
- 같은 변수로 Jaeger·Grafana 같은 외부 OTLP 수집기에도 보낼 수 있다. 다만 외부로 보내면 span 이름과 오류 메시지가 그대로 나간다. 로컬 수집기는 문자열 속성을 버린다.

### 개발용: Effect devtools

span을 OTLP와 함께 devtools 프로토콜로도 보낸다. 두 수집기는 같은 NDJSON 형식을 쓴다.

```sh
node tools/profile/main.ts collect-devtools --port 34437 --out <스크래치>/devtools.ndjson
CONTEXT_AGENT_DEVTOOLS_URL=ws://127.0.0.1:34437 vp run dev
```

`effect/devtools`는 unstable 모듈이다. Effect를 올린 뒤 깨지면 OTLP 경로를 쓴다.

## 2. CPU 프로파일 수집

```sh
node --cpu-prof --cpu-prof-dir=<스크래치>/cpu <진입점>
```

- 프로세스가 정상 종료해야 파일이 써진다. SIGKILL로 끝내면 남지 않는다.
- worker thread도 각자 `CPU.<날짜>.<시각>.<pid>.<thread>.<seq>.cpuprofile`을 남긴다. thread 번호가 0이면 메인 스레드다.

## 3. 요약

```sh
node tools/profile/main.ts summarize <스크래치>/spans.ndjson <스크래치>/cpu/*.cpuprofile --top 20
```

- span NDJSON: 이름별 total·self·count·p50·p95·max·오류·중단 수와, 가장 느린 span의 바깥쪽부터의 경로.
  - self는 자식 span 시간을 뺀 값이다. 자식이 동시에 돌면 0으로 잘린다.
- `.cpuprofile`: 함수별 self·total, 소유자(워크스페이스 폴더·의존성·`node`·VM)별 self, idle·GC 시간.

## 읽는 순서

1. span의 **total 상위**로 느린 단계를 고른다.
2. 같은 이름의 **self**가 크면 그 단계 자체가 일을 한다. 작으면 자식 span을 따라 내려간다.
3. **p95가 p50보다 훨씬 크면** 대기·경합·재시도를 의심한다. 오류·중단 수도 같이 본다.
4. CPU 시간이 문제라면 CPU 요약의 **소유자별 self**로 우리 코드인지 의존성인지 먼저 가른다. 그다음 함수 self 상위를 본다.
5. 변경 전후를 비교할 때는 같은 시나리오로 두 번 수집하고, 두 요약 출력을 diff한다.

## 알려진 공백

- worker(임베딩·Kiwi·가져오기·redaction·native 검색) 내부의 span은 내보내지 않는다. worker 런타임에는 tracer가 없다. worker 쪽 CPU는 `--cpu-prof`로 본다.
- 메모리·delegate·workflow 도구는 채팅 실행(Goal native owner 포함)과 BTW 질문(`BtwChat.handle`)의 context로 돌아 그 span과 같은 trace에 붙는다. 파일·셸·MCP·스킬·백그라운드 같은 다른 도구 콜백은 Layer를 만들 때의 context로 돌아, tracer는 있지만 run과 별개의 trace가 된다.
- span이 없는 구간은 보이지 않는다. 필요하면 해당 함수를 `Effect.fn("이름")`으로 바꾸거나 `Effect.withSpan`을 단다. hot path에는 `Effect.fnUntraced`를 유지한다.
- span 속성에 프롬프트·모델 ID·endpoint·자격증명을 넣지 않는다. 로컬 수집기가 문자열을 버리더라도 외부 OTLP로는 그대로 나간다.
