# tantivy-bench

## Overview

기억 검색 재설계에서 Tantivy 0.27 색인을 재는 벤치 CLI다. 제품 코드가 아니며, 저장소 다른 곳에서 쓰지 않는다. storage 폴더 사본(벤치 사본)의 `agent.db`를 읽기 전용으로 열어 사본의 `tantivy/` 아래에 색인을 만든다. 그다음 평가 세트(`packages/memory-agent/eval/search-set.ts`)의 item을 같은 사본의 색인에서 찾는다. 결과 순위는 평가 세트의 run 파일로 남겨 판정과 점수를 받게 하고, 시간과 크기를 잰다. 앱의 SQLite FTS5 검색은 평가 세트의 `fts` 명령이 앱과 같은 node SQLite에서 돌려 run과 시간을 남긴다. 이 벤치의 결과는 그것과 비교한다. 측정 결과는 `docs/memory-search-measurements.md`에 적는다.

색인은 세 가지다. 모두 숨긴(suppressed) 노드를 빼고, 필드 번호가 같은 schema를 쓴다.

- `global` — 필드 `words`(글자·숫자 단어, 소문자, FTS5 unicode61과 비슷), `morph`(FTS5 `nodes_morph`가 담은 Kiwi 형태소, 같은 방식으로 나눔), `ngram`(위치가 있는 소문자 3글자 조각, FTS5 trigram과 같음)을 둔다. 프로젝트는 fast field이고, 결과를 모으는 callback에서 거른다.
- `project/<번호>` — 프로젝트마다 색인 하나. 필드는 global과 같다.
- `prefixed` — 단어 앞에 프로젝트 번호를 붙인 색인 하나(`3_word`).

## Interface

- `tantivy-bench build <copy>` — 세 색인을 새로 만들고 색인마다 노드 수, 걸린 시간, 크기, segment 수를 출력한다.
- `tantivy-bench query <copy> [--repeat N]` — item마다 각 검색을 N번 돌려 마지막 번의 시간을 잰다. global 색인 검색 네 가지를 평가 세트의 run `tv-words`·`tv-morph`·`tv-lexical`·`tv-ngram`으로 `<copy>/search-set/runs/`에 새로 쓴다. `tv-lexical`(단어와 형태소 전체)의 같은 질의는 다른 방법 다섯 가지로도 찾아 시간을 잰다.
  - `per-project` — 프로젝트별 색인에서 찾는다. 모든 프로젝트 색인의 통계를 더해 점수를 매긴다.
  - `per-project exhaustive` — 위와 같되 pruning 없이 일치하는 문서를 모두 점수 매긴다.
  - `hybrid` — 자기 프로젝트는 그 프로젝트 색인에서, 다른 프로젝트는 global 색인에서 찾는다.
  - `exhaustive` — global 색인에서 pruning 없이 일치하는 문서를 모두 점수 매긴다.
  - `prefixed` — prefixed 색인에서 찾는다. 시간만 잰다.
- 출력 표 — 검색별로 p50·p95·최대·평균 시간과 2000 ms를 넘긴 item 수를 보인다. item당 callback까지 온 문서 수와 item당 일치한 문서 수도 보인다. 앞의 네 방법은 `tv-lexical`과 견줘, 점수는 같고 같은 점수의 다른 문서를 남긴 item 수와 점수가 다른 item 수를 보인다.
- 입력: `<copy>/search-set/`의 `items.jsonl`·`needs.jsonl`·`query-terms.jsonl`(평가 세트 `terms` 명령이 쓴다).
- 빌드: `cargo build --release`(이 디렉터리, 독립 workspace).

## Invariants

- 프로젝트 필터는 global 색인에서 MUST 절이 아니라 pruning callback 안에서 건다. MUST 절은 단어들의 합집합을 교집합으로 바꿔 Block-WAND top-k pruning을 끈다. 걸러진 문서는 넘어야 할 점수를 그대로 돌려줘 그 점수를 올리지 않는다.
- 프로젝트별 색인의 점수는 모든 프로젝트 색인의 통계(문서 수, 필드 token 수, 단어별 문서 수)를 더해 매긴다. 한 질의의 weight 하나를 범위 안 프로젝트들의 segment에 차례로 돌리고, 넘어야 할 점수는 다음 segment로 이어진다. 그래서 점수는 global 색인과 같아야 한다. 출력 표의 "vs tv-lexical" 열이 그 확인이다.
- 점수 비교는 검색어 수만큼의 f32 ulp 안에서 같으면 같다고 본다. pruning 없이 다 점수 매기는 방식은 단어별 점수를 다른 순서로 더해 마지막 bit가 다를 수 있다. 마지막으로 남긴 점수와 같은 점수의 문서가 여럿이면 남는 문서가 방식마다 다르다. Block-WAND는 남긴 점수보다 큰 문서만 받아 먼저 본 문서를 남기고, 다른 방식은 seq가 작은 문서를 남긴다. 이런 item은 "ties"로 따로 센다. 점수가 다른 item은 처음 다른 곳(item id, 범위, 순위, 두 점수와 seq)을 표 아래에 출력한다.
- Block-WAND가 block을 건너뛰는 상한은 그 block에서 가장 좋은 (길이, 빈도) 쌍의 점수다. 이 쌍은 segment를 쓸 때 그 segment의 평균 길이로 고른다. 다른 통계로 점수를 매기면 그 쌍이 가장 좋지 않을 수 있어 상한이 낮아지고, top k에 들어갈 문서를 건너뛸 수 있다. 큰 색인의 segment는 평균 길이가 색인 전체와 비슷하지만 프로젝트 색인은 그렇지 않을 수 있다. pruning 없는 방식은 이 영향을 받지 않는다.
- 기록된 질문은 그 호출의 seq 이전 노드만 찾는다. callback에서 seq fast field로 거른다.
- `tv-ngram`은 검색어 하나를 그 3글자 조각들의 구절로 찾는다. FTS5 trigram이 따옴표 친 검색어를 찾는 방식과 같다. Tantivy 기본 n-gram tokenizer는 모든 조각의 위치를 0으로 두므로 쓰지 않는다.
- 자기 프로젝트를 먼저 찾고 다른 프로젝트를 찾은 뒤 순위를 번갈아 합친다. 앱의 합치는 방식과 같다.
- 기억 원문을 출력하지 않는다. 출력은 개수, 크기, 시간뿐이다.

## Side Effects

- `<copy>/tantivy/`를 지우고 다시 쓴다(build).
- `<copy>/search-set/runs/`의 run 파일 `tv-words`·`tv-morph`·`tv-lexical`·`tv-ngram` 네 개를 덮어쓴다(query).
- `agent.db`는 읽기만 한다.

## Verification

- Run: `cargo check` (이 디렉터리)
