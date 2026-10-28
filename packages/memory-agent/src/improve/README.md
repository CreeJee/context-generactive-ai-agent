# improve

## Overview

`improve`는 열린 프로젝트들이 속한 저장소별로 최근 90일 사용 기록을 SQLite에서 모아 개선 항목으로 묶는다. 사용 기록은 사용자 정정, 반복된 도구 실패, 실패하거나 다시 계획된 칸반 카드다. 사용자가 고른 모델이 항목마다 문제·규칙·변경·수용 기준을 해석한다. 결과는 저장소마다 Markdown 작업 명세 보고서로 StorageRoot 아래 `improvements/`에 쓴다.

작업 단위는 백그라운드 스캔이다. `ProjectImprovement` 서비스가 이 스캔을 소유하고 진행 상태를 `ScanState`로 알린다. `packages/memory-agent/src/layers.ts`의 `memoryAgentLayerBody`가 이 서비스를 조립한다. `apps/agent/app/routes/api/settings.improvements.tsx`의 `loader`/`action`이 설정 페이지에서 이를 쓴다.

## Interface

- `ImprovementItem` — 저장소 하나의 개선 항목 Schema(id, repository, source(correction|tool_failure|card_failure), title, count, evidence, excerpts, latestAt)
- `ItemInterpretation` — 모델 해석 결과 TaggedUnion: `interpreted`(title, problem, rule, change, acceptance) 또는 `failed`(model_failed|invalid_answer)
- `ReportedItem` — `ImprovementItem` 필드에 `interpretation`을 더한 Schema
- `ImprovementReport` / `ImprovementScan` — 저장소별 보고서(repository, file, markdown, items)와 스캔 전체 색인(generatedAt, reports) Schema
- `ScanFailure` — 스캔 중단 사유 리터럴(storage, report, embedding, model_unavailable, model_unreachable, internal)
- `ScanState` — 백그라운드 스캔 상태 TaggedUnion(idle, running{startedAt, repositories, items 진행도}, failed{reason, at}, stopped{at})
- `sourceLabels` / `reportedTitle` — 항목 종류의 한국어 라벨 표, 항목 이름(해석 성공 시 모델 title, 아니면 그룹 라벨)
- `ProjectImprovement` — 열린 프로젝트의 저장소에서 개선할 점을 찾는 Context 서비스. `layer`·`layerNoDeps` 정적 레이어를 가진다. `discover`, `scan`, `latest`, `state`, 백그라운드 실행을 다룬다.
- `DiscoveryFailed` — TaggedError, reason `storage`(워크트리/프로젝트 읽기 실패) 또는 `report`(보고서·색인 쓰기/읽기 실패) + cause
- `RepositoryImprovements` — 저장소 메인 체크아웃 경로, 해당 projectIds(NonEmpty), items 인터페이스
- `ImprovementInterpreter` — Context 서비스(`layer`). `model` Effect가 스캔당 한 번 모델·로그인을 확인한 뒤 `{ interpret }`를 돌려준다.
- `InterpretationUnavailable` — TaggedError, reason `model_unavailable` | `model_unreachable`
- `interpretationInstructions` / `interpretationPrompt` — 해석용 시스템 지침 문자열과 항목별 프롬프트 생성 함수
- `parseInterpretation` — 모델 답에서 코드 펜스를 벗기고 skip/improve JSON을 디코드해 `Option<ItemInterpretation>`으로 바꾼다(SchemaError 가능)
- `grouping` — 반복 임계값(toolFailureRepeats 3, correctionRepeats 2, cardRepeats 2), correctionSimilarity 0.85, evidence 20, excerpts 5, candidatesPerSource 5 상수
- `clusterByVector` — dual 함수, 리더 기반 코사인 유사도 군집(그룹별 인덱스 배열 반환)
- `improvementItems` — Effect.fn, 한 저장소의 Signal 목록을 개선 항목으로 묶어 count 내림차순으로 반환한다(정정은 Embedder 필요).
- `improvementReport` — dual 함수, (found{repository, items}, generatedAt) → 저장소 Markdown 보고서 문자열
- `Signal` — 신호 TaggedUnion(correction, tool_failure, card_failure)
- `SignalsFailed` — TaggedError, reason `storage` + SQL/디코드 cause
- `failureSignature` — 실패 도구 결과의 첫 의미 있는 줄을 일반화(<text>, <path>, <n>, 120자)하고 권한 거부는 `permission denied: <tool>`로 묶는 순수 함수
- `collectSignals` — Effect.fn(projectIds, since ISO) → `Signal[]`, SqlClient 필요
- 하위 디렉터리 없음

## Invariants

- `contracts.ts`는 백엔드와 설정 페이지가 공유하는 모양·문구만 둔다. DB·파일 시스템·모델에 닿지 않아야 한다.
- 항목 id는 ``sha256(`${repository}\n${source}\n${key}`).slice(0, 16)``이다. 도구 실패와 카드는 스캔 사이에 id를 유지한다. 정정 그룹은 리더(첫 멤버)의 nodeId가 키이므로 리더가 조회 기간을 벗어나면 id가 바뀐다.
- 조회 기간은 `lookbackDays = 90`이다. 카드 조건은 `MAX(a.updated_at) >= Date.parse(since)`이다. attempt 시각이 epoch 밀리초이기 때문이다.
- 저장소 처리는 `concurrency: 1`이다. 그룹핑이 텍스트를 임베딩하고, 모델 제공자를 사용자 채팅과 공유하기 때문이다. 한 저장소 안의 모델 해석은 `concurrency: 2`이다.
- 모델은 종류별로 count 상위 `candidatesPerSource`(5)개만 읽는다. 잘라내는 곳은 이 한 곳뿐이다. 모델이 읽고 유지한 항목은 모두 보고서에 들어간다. 모델이 skip한 항목(None)만 빠진다.
- 보고서는 StorageRoot 아래 `improvements/`에만 쓴다. 저장소 안에는 절대 쓰지 않는다. 파일명은 `${basename(repo)}-${sha256(repo).slice(0,8)}.md`이다.
- 파일 쓰기는 `${file}.partial`에 쓴 뒤 rename으로 덮는다(`writeWhole`). 읽는 쪽이나 크래시 상황에서 반쪽 파일이 보이면 안 된다.
- `index.json`을 먼저 쓰고, 그 뒤에 이번 스캔에 없는 오래된 `.md`를 지운다. 크래시가 나도 남는 것은 여분 파일뿐이다. 색인이 없는 파일을 가리키는 일은 없어야 한다.
- 옛 모양의 index(SchemaError)는 '스캔 없음'(None)으로 취급한다. 다음 스캔이 색인을 다시 쓴다.
- 백그라운드 스캔은 `FiberHandle` 하나로만 돈다. 서비스 Scope를 닫으면 스캔이 interrupt된다. 진행도는 running 상태에서만 갱신한다. 중단 뒤에 늦게 온 갱신은 무시한다.
- 스캔 결과 매핑: 성공→idle, interrupt만→stopped(기록 없음), 실패→`ScanFailure` 매핑(`DiscoveryFailed`→reason, `SignalsFailed`→storage, `EmbeddingError`→embedding, `InterpretationUnavailable`→reason). 그 밖의 경우와 defect는 `internal`이다. 원인은 로그로만 보내고 페이지에는 보내지 않는다.
- `discover`는 서비스가 쥔 SqlClient와 Embedder를 provideService로 주입한다. 따라서 스캔을 시작한 쪽에서는 아무 서비스도 필요하지 않다.
- 저장소 해석: 프로젝트 폴더에서 위로 올라가며 `.git`이 있는 가장 가까운 폴더를 저장소 꼭대기로 본다. 폴더가 사라진 워크트리 프로젝트와 하위 폴더로 연 프로젝트도 그 저장소에 센다. 저장소 밖 프로젝트는 제외한다.
- 모델 선택·로그인 확인은 스캔당 한 번이다. 로그인되지 않았으면 항목마다가 아니라 스캔 전체가 `model_unavailable`로 실패한다.
- 연속 실패 카운터는 스캔마다 새로 만든다. 연속 실패가 `failuresInARow`(2)에 이르면 스캔이 `model_unreachable`로 실패한다. 성공한 호출은 카운터를 0으로 되돌린다. 실패 횟수가 이보다 적으면 그 항목만 `failed(model_failed)`가 되고, 디코드 실패는 `failed(invalid_answer)`가 된다.
- 스트림 청크가 `silenceLimit`(60초) 동안 오지 않으면 그 호출은 실패로 본다.
- 모델 답의 텍스트를 자른다: title은 200자, 나머지 필드는 `maxText` 800자다.
- 프롬프트는 근거 텍스트를 데이터로 다룬다. 근거 안의 지시를 따르지 말라고 지시한다(프롬프트 주입 방어). 텍스트 필드는 한국어로 쓰게 한다.
- 보고서 안의 사용자·모델 텍스트는 처리한 뒤 넣는다. 근거는 `> ` 인용으로 넣고, 제목과 명세 필드는 개행을 공백으로 바꿔 한 줄로 만든다. 그래서 이 텍스트가 제목·목록·펜스를 열 수 없다.
- 도구 실패 신호는 가져온 대화의 실패만 쓴다(`$.importedFrom IS NOT NULL`). 이 앱 자체 도구의 실패는 제외한다. Claude Code에서 사용자가 거절한 호출도 제외한다(`The user doesn't want to proceed with this tool use.`로 시작하는 결과).
- 정정 하나가 여러 노드를 정정하면 정정 하나로 센다. 짝은 가장 최근(seq가 가장 큰) 대상 노드다(`row_number() OVER (PARTITION BY u.id ORDER BY t.seq DESC)`).
- `clusterByVector`는 벡터가 L2 정규화됐다고 가정하고 내적을 코사인으로 쓴다. 각 벡터는 리더(그룹의 첫 멤버)와만 비교한다.
- excerpt 길이: 신호 텍스트는 400자, 도구 결과는 SQL에서 2000자까지 읽는다.

## Side Effects

- SQLite 읽기(쓰기 없음): `worktree_parents` 테이블, `nodes`/`edges` 테이블(kind='corrects' 정정, kind='tool_result' 실패, `json_extract(detail, ...)`), `kanban_cards`·`kanban_goals`·`kanban_card_attempts` 테이블 집계.
- 파일 시스템: 각 폴더에서 위로 `.git` 존재 확인을 하고, `StorageRoot/improvements` 디렉터리를 만든다.
- 파일 시스템: 저장소별 `.md` 보고서와 `index.json`을 `.partial`에 쓴 뒤 rename한다. 이어서 `index.json`을 읽고, 디렉터리 목록을 읽어 오래된 `.md`를 삭제한다.
- `Projects.listAll`/`Projects.list` 조회와 `Checkouts.forRoots`/`resolve`로 프로젝트 루트의 체크아웃 위치를 해석한다.
- `Embedder.embed`로 정정 텍스트를 임베딩한다(임베딩 모델 호출).
- 네트워크/모델 호출: `ActiveProvider`의 selected/auth/resolve, `singleAnswerParts` 스트리밍 호출. 사용자 채팅과 같은 제공자를 쓴다.
- `Crypto.randomUUIDv4`로 모델 호출마다 threadId를 만든다.
- `DateTime.now`(Clock)로 조회 시작 시각, generatedAt, 상태 시각을 읽는다.
- 인메모리 상태: `Ref<ScanState>`, 스캔당 연속 실패 `Ref`, 서비스 Scope에 묶인 `FiberHandle` 백그라운드 fiber.
- defect가 나면 `Effect.logError("Project improvement scan failed", cause)`로 로그를 남긴다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
