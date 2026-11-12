# eval

## Overview

`packages/memory-agent/eval`는 memory-agent의 평가·실험 스크립트 모음이다. 압축(compaction) 정책 비교, 기억 검색 recall과 단계별 지연 측정, 프롬프트 오버헤드, 메모리 footprint, 구조화 기억 벤치마크를 다룬다. 유료 실 provider 파일럿(live-compaction, live-delegation)과 Anthropic 구독 usage 1회 probe도 여기 있다.

대부분 `node eval/<file>.ts`로 직접 실행하는 진입 스크립트다. 각 스크립트는 `packages/memory-agent/src/layers.ts`의 `memoryAgentLayer`, provider registry, OAuth keychain 같은 앱 코드를 임시 storage root 위에 조립해 실제 경로를 측정한다. 공용 모듈(pilot-guard, request-token-budget, stored-profiles, recall-corpus 계열)은 스크립트끼리 공유하는 guard, 토큰 추정, 코퍼스를 제공한다.

## Interface

- `evaluateCompactionEffect` — legacy(10턴 합본 요약·원문 4턴)와 current(다시 계산할 때마다 이어 쓰는 세션 요약 하나·원문 2턴·제한된 retrieval) 압축 요청을 합성 대화(16/20/26턴)로 비교한다. 결과는 `CompactionEvaluation`이고, 실패 타입은 `CompactionFailed`다. (`compaction.ts`)
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
- `copyLayer` / `copyEmbedder` / `copyDatabase` — 실제 storage 폴더의 사본(agent.db·vectors/·models/) 위에 앱 서비스를 앱과 같은 방식으로 연다. 임베더는 현재 로컬 모델의 identity 중 사본 벡터가 가장 많은 모드의 파일(`identityMode`)을 non-local runtime으로 쓰고(이전 모델 벡터는 남아 있어도 읽지 않는다), 질의 임베딩만 임베더 identity와 텍스트를 키로 사본의 `embed-cache.jsonl`에 캐시한다. `copyLayer`는 첫 검색 전에 사본의 `lexical_changes`를 lexical 색인에 모두 반영한다(사본의 첫 실행은 색인 전체를 만든다). `reranker`를 켜면 로컬 reranker(`Reranker.localGpu`, 파일은 사본의 `models/`)를 띄우고 답할 때까지 기다린 뒤 검색한다. `copyDatabase`는 사본 agent.db를 read-only `SqlClient`로 연다. (`copy-storage.ts`)
- CLI 진입 스크립트(export 없음) — `anthropic-usage-probe.ts`, `compaction-cli.ts`, `live-compaction.ts`, `live-delegation.ts`, `memory-research-lab.ts`(인자: `fake-embed`·`real-embed`·`fts-only`·`morph-only`·`full` 중 1단계), `memory.ts`(시나리오 `only`), `prompt-overhead.ts`(인자 없음: 내장 skill만 있는 임시 프로젝트. 프로젝트 경로: 그 프로젝트의 AGENTS.md·skill·MCP와 사용자 global skill·MCP를 모두 신뢰하고 Kagi를 켠 최악 조건. 둘 다 서브에이전트에 한 번 위임해 부모와 자식의 첫 요청을 출처별 토큰으로 나눈다), `recall.ts`(`printRecall`. 인자로 구성 이름 하나를 고른다), `relevance.ts`(`build`·`score`. find_memory 결과 중 모델이 연 노드를 정답으로 보는 예전 세트), `search-set.ts`(effect/cli 하위 명령 `recorded`·`rounds`·`turns`·`pool`·`app-run`·`rerank`·`rerank-inputs`·`judge`·`judge-check`·`agreement`·`score`. 모델을 묻는 명령은 `--provider`와 `--model`로 앱에서 고른 것과 다른 provider의 모델을 쓸 수 있다. 판정은 한 판정 모델의 등급끼리 견주므로, 앱의 선택이 바뀌어도 세트를 시작한 판정 모델을 그대로 쓴다. 아래 search-set/ 참고), `structured-memory.ts`(`program`·`BenchmarkFailed`), `tool-use.ts`(인자: 케이스 이름들, `--repeat N`. 사용자가 고른 모델로 작은 프로젝트마다 요청 하나를 돌리고, 도구 호출과 답·파일이 케이스의 기대를 지켰는지 본다. 케이스는 실사용 기록의 도구 실패에서 가져온다. `mcp` 케이스는 임시 storage의 `mcp.json`에 둔 eval MCP 서버 `tracker`·`code-index`를 그 프로젝트에 신뢰한다), `tool-use-mcp-server.ts`(첫 인자 `tracker`·`code-index`로 고르는 stdio MCP 서버. 답은 케이스의 프로젝트 파일에 맞춘 고정값이다).
- `search-set/` — 기억 검색 평가 세트. 기록된 find_memory 호출(`recorded.ts`)과 모델이 지난 라운드에서 쓴 질문(`rounds.ts`)이 need(찾던 것)와 item(질의)이 된다. 여러 검색 시스템의 순위(`pool.ts`: 앱 검색, native read의 vector·text·morph 목록. `app-run --rerank`는 find_memory처럼 reranker로 다시 줄 세운 앱 검색)를 모아 모델이 need×node를 0·1·2로 판정한다(`judge.ts`). 이미 판정한 쌍은 다시 묻지 않으므로 새 시스템은 그것만 찾은 노드만 판정하면 된다. `rerank.ts`는 다른 run들의 상위 id(run마다 `--depth`, 기본 10개)를 번갈아 합쳐 후보로 삼는다. 로컬 cross-encoder reranker(`--model`, Hugging Face의 ONNX 모델, 쌍마다 점수 하나)가 item의 (질문, 노드 원문) 쌍을 한 batch로 점수 매기고, 그 순서를 새 run(`--name`)으로 남긴다. 모델은 앱의 embedder처럼 transformers.js로 띄운다(`--device` 기본 webgpu, `--dtype` 기본 fp32, `--max-tokens` 기본 256). 파일은 사본의 `rerank-models/`에 받으며, 노드 원문은 기기를 떠나지 않는다. 후보 run이 이미 item이 읽을 수 있는 노드만 남기므로 rerank run도 그렇다. item마다 batch에 걸린 시간(tokenizing 포함)의 p50·p95·최대·평균, read 예산(2000 ms)을 넘긴 수, item당 후보 수, padding된 token 길이를 출력한다. `turns.ts`는 턴 경로의 기억 조회(압축 때 `retrievalAppendix`: 최근 사용자 발언 셋을 최신 발언부터 이어 6,000자에서 자른 질문)와 같은 모양의 need를 더한다. 기록된 recall need는 질문이 대부분 짧아 reranker가 읽는 길이를 넘는 경우가 드물어서, 아무 턴에서 뽑는 `any`와 질문이 reranker가 읽는 token보다 긴 턴에서 뽑는 `long` 두 묶음으로 뽑는다(사용자 노드 id의 hash 순서, 세션마다 하나). need는 `recall`(판정 모델은 발언을 최신 발언이 마지막이 되게 읽는다), item은 앱의 질문인 `turn` 형식이고, 그 턴의 run이 처음 저장한 노드 전에 저장된 노드만 찾는다. `rerank-inputs.ts`는 앱의 reranker(`rerankModel`, 사본의 `models/`, WebGPU, 앱과 같은 `pairTokens`)로 앱이 넘기는 후보(native read의 vector·morph·text 상위 10개를 번갈아 합친 것)를 여러 입력 방식으로 점수 매겨 방식마다 run(`<name>-<방식>`)을 남긴다. 방식은 질문(item 그대로, 턴 경로의 질문, 최신 발언만, 발언마다 따로 매겨 가장 높은 점수), 쌍을 자르는 방식(`PairCut`), batch(가장 긴 쌍에 맞춘 padding, 쌍 하나씩, 길이로 나눈 두 batch)의 조합이다. 한 item의 방식은 연달아 돌려 기계 부하가 고르게 걸리게 하고, 같은 입력은 한 번만 돌린다. item마다 방식별 시간과 padding이 점수를 옮긴 크기를 `rerank-inputs-<name>.jsonl`에, 턴 경로 질문이 reranker가 읽는 자리를 얼마나 차지하는지를 `slices.jsonl`에 남긴다. `score.ts`는 nDCG@10·Recall@20·MRR·Ans@10·judged@10을 형식·언어·정확 명칭·나이별로, 그리고 `slices.jsonl`의 slice별로 낸다. 기준 run(첫 run)과 견준 nDCG@10 변화는 slice마다 같은 item끼리의 평균 변화와 95% 구간(item별 변화의 정규 근사), 이긴 item과 진 item 수로 낸다. `--complete`를 주면 모든 run의 상위 10개가 다 판정된 item만 센다(판정이 덜 끝났을 때 판정 안 된 노드가 run마다 다르게 불리해지지 않게). 기록된 질문은 그 호출 seq 이전에 저장된 노드만 검색한다(`beforeSeq`). 결과를 받은 뒤 거르지 않으므로, 나중 노드가 상위 자리를 차지했다가 빠져 목록이 짧아지지 않는다. 모델은 앱에서 고른 모델(`EvalModel`, `model.ts`)이고 사본 안 `search-set/model-storage`에 따로 띄운다. 파일 형식은 `files.ts`, 노드 조회는 `nodes.ts`.

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
- memory-research-lab은 `packages/memory-agent`를 cwd로 실행해야 한다. 프로젝트 root는 `process.cwd()`, 임시 root는 `<repo>/node_modules/.vp-tmp`다. 단계마다 별도 임시 storage root를 쓴다. 모델 파일을 읽을 수 없으면 해당 단계는 실패하지 않고 사유와 함께 skip된다.
- search-set과 relevance는 기억 원문을 출력하지 않는다. 원문이 든 파일(needs·items·judgments·runs)은 사본의 `search-set/` 안(git 밖)에만 둔다. 판정과 질문 작성은 사용자가 앱에서 고른 모델에만 보낸다.
- Effect 경계 규칙: 도메인 Effect는 호출자 runtime에서 실행한다. eval 스크립트가 native/Promise 경계에서 `runNativeEffect`, `ManagedRuntime`, `Effect.runPromise`로 실행하고, runtime은 `finally`에서 dispose한다.

## Side Effects

- SQLite: `storedOAuthProfiles`는 사용자 앱 DB를 read-only로 연다(`Database.over` + `acquireRelease`). live-delegation은 임시 storage의 DB에 1초마다 SQL 폴링을 한다. 대상 테이블은 `agent_run_attempts`, `work_tasks`, `chat_runs`, `parent_notifications`다. 파일럿과 lab 실행은 임시 storage root에 `memoryAgentLayer` DB를 만들고 쓴다.
- Keychain: `OAuthKeychain.keychain`으로 OAuth 자격증명을 읽는다(anthropic-usage-probe, live-delegation).
- 네트워크(유료): anthropic-usage-probe는 Anthropic 구독 usage 요청을 1회 보낸다. live-compaction과 live-delegation은 OpenAI 구독 모델을 실제 호출한다. structured-memory는 provider 호출 여부를 직접 읽지 않았다. 다만 `ReportedUsage`, `inputLimit`/`outputLimit` 심볼이 있다.
- 파일 시스템: 기본 storage root의 `config.json`을 읽는다(live-delegation). `makeTempDirectoryScoped`로 임시 디렉터리를 만들고 fixture 소스(`src/checksum.ts`, `main.ts`, `child.ts`)를 쓴다. memory-research-lab은 실제 storage root의 모델 파일(로컬 모델의 cpu/gpu 파일)을 stat하고, `node_modules/.vp-tmp` 아래에 임시 root를 만든다.
- tool-use는 기본 storage root의 `config.json`을 임시 storage로 복사해 사용자가 고른 provider·모델로 실제 요청을 보낸다. openai-compatible 키는 OS keychain에서 읽기만 한다. 로컬 모델이면 비용이 없고, 구독 모델이면 그 사용량을 쓴다. 케이스마다 임시 프로젝트를 `full` 권한으로 만들고 그 안의 파일만 바꾼다. 임시 storage에 `mcp.json`을 쓰고, `mcp` 케이스마다 `tool-use-mcp-server.ts`를 자식 프로세스로 띄운다.
- prompt-overhead에 프로젝트 경로를 주면 기본 storage root의 `mcp.json`을 임시 storage로 복사하고 홈의 `.agents/skills`를 읽는다. 설정된 MCP 서버를 실제로 띄우거나(stdio) 접속해(HTTP) `tools/list`까지 한다. 사용자 storage, keychain, 프로젝트에는 쓰지 않는다(secret은 `SecretStore.memory`).
- 자식 프로세스: `memory.ts`의 `footprint`는 `runProcess`로 macOS physical footprint(`phys_footprint`, `phys_footprint_peak`)를 조회한다.
- 환경·프로세스: live-compaction은 `MEMORY_AGENT_ENABLE_PAID_COMPACTION_PILOT`를 읽는다. 여러 스크립트가 `process.argv`로 단계나 시나리오를 고르고, 실패 시 `process.exitCode = 1`을 설정한다. memory-research-lab은 `process.hrtime`으로 embed 시간을 잰다.
- 모듈 수준 가변 상태: 파일럿 예산 카운터(`calls`, `totalCalls`, `estimatedInputTokens`)와 lab의 `nanos` 누적값이 있다.
- 타이머: `Effect.timeout("45 seconds")`가 chat run마다 걸린다(live-compaction). `Schedule.spaced("1 second")`로 폴링한다(live-delegation).
- stdout: `Console.log`로 JSON이나 markdown 보고서를 출력한다.

## Verification

- Run: `vp run memory-agent#typecheck`
