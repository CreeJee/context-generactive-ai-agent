# tantivy-bench

## Overview

기억 검색 재설계에서 Tantivy 0.27 색인을 재는 벤치 CLI다. 제품 코드가 아니며, 저장소 다른 곳에서 쓰지 않는다. storage 폴더 사본(벤치 사본)의 `agent.db`를 읽기 전용으로 열어 사본의 `tantivy/` 아래에 색인을 만든다. 그다음 평가 세트(`packages/memory-agent/eval/search-set.ts`)의 item을 같은 사본의 색인에서 찾는다. 결과 순위는 평가 세트의 run 파일로 남겨 판정과 점수를 받게 하고, 시간과 크기를 잰다. 앱의 SQLite FTS5 검색은 평가 세트의 `fts` 명령이 앱과 같은 node SQLite에서 돌려 run과 시간을 남긴다. 이 벤치의 결과는 그것과 비교한다. 측정 결과는 `docs/memory-search-measurements.md`에 적는다.

색인은 하나다. 숨긴(suppressed) 노드를 빼고 다음 필드를 둔다.

- `morph` — FTS5 `nodes_morph`가 담은 Kiwi 형태소. 글자·숫자 단어로 나누고 소문자로 만든다.
- `ngram` — 위치가 있는 소문자 3글자 조각. FTS5 trigram과 같다.
- `lindera` — Lindera ko-dic 형태소에서 Kiwi와 같은 규칙으로 고른 검색어.
- `lindera_stop` — 같은 형태소에서 Lucene Nori 기본 stop tags를 뺀 검색어.

두 Lindera 필드는 Kiwi가 분석한 노드만 채운다. 프로젝트와 seq는 fast field이고, 결과를 모으는 callback에서 거른다.

## Interface

- `tantivy-bench build <copy>` — 색인을 새로 만들고 노드 수, 걸린 시간, 크기, segment 수를 출력한다. Lindera가 분석한 노드 수, 글자 수, 걸린 시간도 출력한다.
- `tantivy-bench query <copy> [--repeat N]` — item마다 각 검색을 N번 돌려 마지막 번의 시간을 잰다. 검색 네 가지를 평가 세트의 run으로 `<copy>/search-set/runs/`에 새로 쓴다.
  - `tv-morph-all` — Kiwi 검색어 전부
  - `tv-lindera` — Kiwi 규칙의 Lindera 검색어 전부
  - `tv-lindera-stop` — Nori stop tags의 Lindera 검색어 전부
  - `tv-ngram` — trigram 검색어

  질문을 Lindera로 나누는 시간도 잰다.

- 출력 표 — 검색별로 p50·p95·최대·평균 시간과 2000 ms를 넘긴 item 수를 보인다. item당 점수를 매긴 문서 수도 보인다.
- 입력: `<copy>/search-set/`의 `items.jsonl`·`needs.jsonl`·`query-terms.jsonl`(평가 세트 `terms` 명령이 쓴다).
- 빌드: `cargo build --release`(이 디렉터리, 독립 workspace). ko-dic 사전을 바이너리에 넣어 release 바이너리가 약 97 MB다.

## Invariants

- 일치하는 문서는 모두 점수를 매긴다. 질의는 검색어 여러 개의 합집합이어서 Block-WAND top-k pruning으로는 거의 줄지 않는다. 쟀을 때 일치 문서의 절반쯤만 건너뛰었고, 문서마다 드는 비용 때문에 더 느렸다. 모두 점수를 매기면 걸러지는 문서와 관계없이 순위가 정확하다. 마지막으로 남긴 점수와 같은 점수의 문서가 여럿이면 seq가 작은 문서를 남긴다.
- 프로젝트별 색인, 단어 앞에 프로젝트 번호를 붙인 색인, 단어(`words`)와 단어+형태소 검색은 재고 뺐다. 결과는 `docs/memory-search-measurements.md`에 있다.
- 기록된 질문은 그 호출의 seq 이전 노드만 찾는다. callback에서 seq fast field로 거른다.
- Lindera 검색어는 Kiwi worker(`packages/memory-agent/src/memory/morph/kiwi-worker.ts`)의 규칙을 따른다. NFKC 뒤 형태소를 나누고, 품사 NNG·NNP·NR·VV·VA·XR·SH를 남기되 가벼운 어간(하·되·있 등)과 영문·숫자가 든 형태소는 뺀다. 띄어쓰기 없이 이어진 명사는 합친 것도 더하고, 영문 단어와 숫자는 원문에서 따로 뽑아 모두 소문자로 만든다. 활용·복합·기분석 토큰은 ko-dic의 expression 열(`하/VV/*+았/EP/*`)로 형태소를 나눈다. Kiwi와 Lindera를 같은 조건에서 견주려는 것이다.
- `lindera_stop`은 Lucene Nori의 기본 stop tags(`KoreanPartOfSpeechStopFilter.DEFAULT_STOP_TAGS`: 어미 E*, 조사 J*, 감탄사, 부사, 관형사, 접사, 공백, 미등록)와 문장부호 태그를 뺀 형태소 전부다. 복합어는 Nori 기본값(`discard`)처럼 부분만 남긴다. ko-dic은 활용형을 합친 태그(`바꿨` = `VV+EP`) 한 토큰으로 내므로, 첫 태그만 견주는 `lindera-tantivy`의 `korean_stop_tags` 필터로는 어간을 얻지 못한다. 그래서 두 필드 모두 expression 열로 형태소를 나눈 뒤 고른다.
- `tv-ngram`은 검색어 하나를 그 3글자 조각들의 구절로 찾는다. FTS5 trigram이 따옴표 친 검색어를 찾는 방식과 같다. Tantivy 기본 n-gram tokenizer는 모든 조각의 위치를 0으로 두므로 쓰지 않는다.
- 자기 프로젝트를 먼저 찾고 다른 프로젝트를 찾은 뒤 순위를 번갈아 합친다. 앱의 합치는 방식과 같다.
- 기억 원문을 출력하지 않는다. 출력은 개수, 크기, 시간뿐이다.

## Side Effects

- `<copy>/tantivy/`를 지우고 다시 쓴다(build).
- `<copy>/search-set/runs/`의 run 파일 `tv-morph-all`·`tv-lindera`·`tv-lindera-stop`·`tv-ngram` 네 개를 덮어쓴다(query).
- `agent.db`는 읽기만 한다.

## Verification

- Run: `cargo check`, `cargo test --release` (이 디렉터리, Lindera 검색어 규칙과 ko-dic 합친 태그 테스트)
