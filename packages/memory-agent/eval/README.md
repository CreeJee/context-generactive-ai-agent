# eval

## Overview

`packages/memory-agent/eval`는 memory-agent의 평가·실험 스크립트 모음이다. 압축(compaction) 정책 비교, 기억 검색 recall과 단계별 지연 측정, 프롬프트 오버헤드, 메모리 footprint, 구조화 기억 벤치마크를 다룬다. 유료 실 provider 파일럿(live-compaction, live-delegation)과 Anthropic 구독 usage 1회 probe도 여기 있다.

대부분 `node eval/<file>.ts`로 직접 실행하는 진입 스크립트다. 각 스크립트는 `packages/memory-agent/src/layers.ts`의 `memoryAgentLayer`, provider registry, OAuth keychain 같은 앱 코드를 임시 storage root 위에 조립해 실제 경로를 측정한다. 공용 모듈(pilot-guard, request-token-budget, stored-profiles, recall-corpus 계열)은 스크립트끼리 공유하는 guard, 토큰 추정, 코퍼스를 제공한다.

## Interface

- `evaluateCompactionEffect` — legacy(10턴 합본 요약·원문 4턴)와 current(4턴 불변 블록·원문 2턴·제한된 retrieval) 압축 요청을 합성 대화(16/20/26턴)로 비교한다. 결과는 `CompactionEvaluation`이고, 실패 타입은 `CompactionFailed`다. (`compaction.ts`)
- `evaluateCompaction` — `evaluateCompactionEffect`를 `Effect.runPromise`로 실행하는 native 명령 경계 함수다. (`compaction.ts`)
- `CompactionEvaluation` — 두 프로필의 평균 입력 토큰·cacheable prefix 비율·호출 수, 감소율, evidence reach·정정 반영률, retrieval 토큰, 5개 threshold boolean을 담는 결과 타입이다.
- `evidenceNarrative` — `readStructuredEvidence` 결과 페이지들을 모든 필드와 원문을 보존한 서술형 문단으로 바꾼다. 내용 선택은 그대로 두고 표현만 바꾼다. (`evidence-narrative.ts`)
- `pilotGuarded` — run의 구독 모델을 감싼다. provider에 가기 전에 모든 요청(요약·단일 호출 포함)을 `check`에 넘긴다. (`pilot-guard.ts`)
- `pilotStopped` — 사유 문자열로 파일럿을 중단시키는 실패 Effect를 만든다. (`pilot-guard.ts`)
- `PilotRequest` — guard `check`가 받는 요청 타입이다. `selection`, `prompt`, `estimate`(`RequestTokenEstimate`)를 담는다. (`pilot-guard.ts`)
- `estimateRequestTokens` / `RequestTokenEstimate` — 직렬화된 요청 본문을 모델별 tiktoken encoder로 세어 BPE 토큰을 추정한다. (`request-token-budget.ts`)
- `exceedsRequestTokenBudget` — 추정 토큰에 margin(기본 1.25)을 곱한 값이 상한을 넘는지 판정한다. dual API(data-first/data-last)다. (`request-token-budget.ts`)
- `storedOAuthProfiles` — 앱 DB를 read-only로 열어(`readOnlyProfiles` 레이어) provider별 저장된 OAuth 프로필 목록을 읽는다. (`stored-profiles.ts`)
- `recallSessions` / `recallQueries` / `RecallStatement` / `RecallQuery` — 결정(decisions) recall 평가용 세션 statement 코퍼스와 질의 집합이다. (`recall-corpus.ts`)
- `technicalSessions` / `technicalQueries` — 기술(technical) recall 평가용 세션 코퍼스와 질의 집합이다. (`recall-technical.ts`)
- CLI 진입 스크립트(export 없음) — `anthropic-usage-probe.ts`, `compaction-cli.ts`, `live-compaction.ts`, `live-delegation.ts`, `memory-research-lab.ts`(인자: `fake-embed`·`real-embed`·`fts-only`·`morph-only`·`full` 중 1단계), `memory.ts`(시나리오 `only`), `prompt-overhead.ts`, `recall.ts`(`printRecall`/`printTerms`), `structured-memory.ts`(`program`·`BenchmarkFailed`).
- 하위 디렉터리 없음.

## Invariants

- anthropic-usage-probe는 secret이 없는 이름과 상태만 출력한다. 토큰, 이메일, 응답 값, DB 경로는 출력하지 않는다. 이메일 형태 label은 `[email-like label]`로 가린다. 저장된 Anthropic 프로필이 정확히 1개일 때만 usage 요청을 정확히 1번 보낸다. 그 외에는 `not_called`를 출력한다.
- 저장된 프로필 id는 항상 유효한 keychain slot id로 간주된다. 그래서 `profileStore(profile.id)`를 `Effect.orDie`로 감싼다(anthropic-usage-probe, live-delegation).
- live-compaction 유료 파일럿은 `MEMORY_AGENT_ENABLE_PAID_COMPACTION_PILOT=1`일 때만 실행된다. 주석에 따르면 이 A/B는 자동 catch-up이 수동 /compact 일을 이미 하면 무효다. 실수로 반복하면 안 되고, 재설계한 비교는 새 명시적 유료 opt-in이 필요하다.
- live-compaction 예산: provider 호출은 최대 20회, 요청당 추정 입력 16,000 토큰에 25% margin을 더한다. 추정치는 provider usage나 cached-token 한도가 아니다. guard는 요약 요청을 포함해 provider 요청 전에 멈춘다. 두 arm(`auto` → `auto-plus-manual`)은 순서대로 실행한다. 기준 arm이 evidence나 계산에 실패하면 다음 유료 arm을 돌리지 않는다.
- live-compaction은 7번째 프롬프트 전에 `summaries.catchUp`으로 자동 요약 상태를 맞춘다. 수동 /compact가 아무것도 바꾸지 않으면 `pilot_manual_compact_changed_nothing`으로 실패한다.
- live-delegation은 합성 파일만 쓴다. 사용자 config와 project는 쓰지 않는다. `GlobalConfig.update`는 임시 storage root 안에서만 일어난다. 대상은 openai만이다. 예산은 총 24회, 누적 추정 200,000 토큰, 요청당 30,000 토큰(margin 포함)이다.
- live-delegation의 `settled`는 1초 간격으로 기다린다. 대기 대상은 세 가지다. 자식 attempt(queued/running/waiting/blocked), running chat_run, 아직 끝난 run에 전달되지 않은 parent_notifications. 자식 보고는 첫 run이 끝난 뒤의 완료 follow-up에서만 부모에 도달하기 때문이다.
- compaction 평가의 threshold 5개가 모두 통과해야 한다: 입력 토큰 감소, cacheable 비율 개선, evidence 도달, 정정 반영, `retrievalTokens <= retrievalTokenLimit`. 하나라도 실패하면 compaction-cli가 `process.exitCode = 1`로 끝난다.
- `evidenceNarrative`는 모든 필드와 원문 텍스트를 보존해야 한다. evidence 선택은 바꾸지 않는다. provenance와 changes는 `concurrency: 1`로 반환 순서를 유지한다.
- memory-research-lab은 `packages/memory-agent`를 cwd로 실행해야 한다. 프로젝트 root는 `process.cwd()`, 임시 root는 `<repo>/node_modules/.vp-tmp`다. 단계마다 별도 임시 storage root를 쓴다. 모델·Kiwi 파일을 읽을 수 없으면 해당 단계는 실패하지 않고 사유와 함께 skip된다.
- Effect 경계 규칙: 도메인 Effect는 호출자 runtime에서 실행한다. eval 스크립트가 native/Promise 경계에서 `runNativeEffect`, `ManagedRuntime`, `Effect.runPromise`로 실행하고, runtime은 `finally`에서 dispose한다.

## Side Effects

- SQLite: `storedOAuthProfiles`는 사용자 앱 DB를 read-only로 연다(`Database.over` + `acquireRelease`). live-delegation은 임시 storage의 DB에 1초마다 SQL 폴링을 한다. 대상 테이블은 `agent_run_attempts`, `work_tasks`, `chat_runs`, `parent_notifications`다. 파일럿과 lab 실행은 임시 storage root에 `memoryAgentLayer` DB를 만들고 쓴다.
- Keychain: `OAuthKeychain.keychain`으로 OAuth 자격증명을 읽는다(anthropic-usage-probe, live-delegation).
- 네트워크(유료): anthropic-usage-probe는 Anthropic 구독 usage 요청을 1회 보낸다. live-compaction과 live-delegation은 OpenAI 구독 모델을 실제 호출한다. structured-memory는 provider 호출 여부를 직접 읽지 않았다. 다만 `ReportedUsage`, `inputLimit`/`outputLimit` 심볼이 있다.
- 파일 시스템: 기본 storage root의 `config.json`을 읽는다(live-delegation). `makeTempDirectoryScoped`로 임시 디렉터리를 만들고 fixture 소스(`src/checksum.ts`, `main.ts`, `child.ts`)를 쓴다. memory-research-lab은 실제 storage root의 모델 파일(quint8/fp32, Kiwi `cong.mdl`)을 stat하고, `node_modules/.vp-tmp` 아래에 임시 root를 만든다.
- 자식 프로세스: `memory.ts`의 `footprint`는 `runProcess`로 macOS physical footprint(`phys_footprint`, `phys_footprint_peak`)를 조회한다.
- 환경·프로세스: live-compaction은 `MEMORY_AGENT_ENABLE_PAID_COMPACTION_PILOT`를 읽는다. 여러 스크립트가 `process.argv`로 단계나 시나리오를 고르고, 실패 시 `process.exitCode = 1`을 설정한다. memory-research-lab은 `process.hrtime`으로 embed 시간을 잰다.
- 모듈 수준 가변 상태: 파일럿 예산 카운터(`calls`, `totalCalls`, `estimatedInputTokens`)와 lab의 `nanos` 누적값이 있다.
- 타이머: `Effect.timeout("45 seconds")`가 chat run마다 걸린다(live-compaction). `Schedule.spaced("1 second")`로 폴링한다(live-delegation).
- stdout: `Console.log`로 JSON이나 markdown 보고서를 출력한다.

## Verification

- Run: `vp run memory-agent#typecheck`
