# 벡터 색인 구조 설계 (2026-11-25)

`docs/vector-index-research.md`의 제안을 실제로 만들 수 있게 정한 문서다. 조사 문서의 열린 질문 중
기술 질문은 여기서 답한다. 사양 질문(사용자에게 보이는 동작)은 끝의 "사양 결정"에 따로 둔다.

## 목표

- 한 번의 기억 읽기가 **읽는 프로젝트의 크기**와 k에만 비례한다. 기억 전체 크기에 비례하지 않는다.
- 저장이 바뀐 부분만 쓴다. 읽기는 저장을 기다리지 않는다.
- 다른 프로젝트는 다 읽지 않는다. 질문에 맞을 segment만 골라 읽고, 시간이 모자라면 읽은 데까지 돌려준다.
- 지금 SQLite가 주는 보장(아래 "지금의 보장")을 하나도 잃지 않는다.

## 지금의 보장

`.tvim` 파일은 한 run 내내 지워진 벡터, 옛 벡터, 다른 프로젝트로 옮겨진 벡터를 담고 있을 수 있다. 그것을
가리는 것은 색인이 아니라 읽기 앞의 candidate SQL이다(`packages/turbovec/src/read_session.rs:465-491`).
그 SQL은 고정한 SQLite snapshot 안에서 돌며 다음을 보장한다.

1. SQL이 commit한 벡터만 보인다(`node_vectors` 행이 있다). 색인 저장은 SQL commit보다 먼저 일어난다
   (`indexer.ts:201-242`).
2. 지워진 대화(`work-trace/store.ts:1438`), 비밀값 정리로 다시 embed할 node(`secrets/sweep.ts:257`), 숨긴
   주제(`maintenance.ts:180-184`)의 벡터는 즉시 안 보인다. 색인에서 실제로 빼는 것은 시작할 때와 그래프
   정리 때뿐이다(`native-vector-index.ts:236-276`).
3. node의 **지금** 프로젝트로 거른다. 가져오기의 fold는 node의 `project_id`를 바꾼다(`imports/pass.ts:311-314`).
   `session_id`는 바뀌지 않는다(trigger, `migrations.ts:2704`).
4. 청크 hit을 부모 node로 바꾼다(`COALESCE(c.vector_id, n.seq)`).
5. `beforeSeq`는 부모 node의 seq로 거른다.

## 결정

### 1. 후보 목록 대신 hit 확인

읽기 앞에서 허용 벡터 목록을 만들지 않는다. 색인을 먼저 검색하고, **나온 hit만 SQL로 확인**한다.

- 확인 SQL은 지금 candidate SQL과 같은 조건을 hit의 id에만 건다. `nodes`·`node_vectors`·`node_vector_chunks`
  join, 숨김 목록 제외, 허용 프로젝트, `seq < beforeSeq`다. 같은 snapshot에서 돈다. 비용은 hit 수에 비례한다.
- 그래서 보장 1–5는 그대로 SQLite가 판정한다. 색인은 "어디를 읽을지"만 정하고 "무엇이 맞는지"는 정하지
  않는다. 색인이 늦거나 틀려도 틀린 결과가 나가지 않고, 놓치는 것만 생긴다.
- 확인에서 떨어진 hit 때문에 부모 node가 `vectorK`에 못 미치면 k를 늘려 다시 읽는다. 지금의 청크 합치기
  반복과 같은 자리다. 떨어지는 hit은 아래 3번의 지움 표시로 평소 거의 0이다.
- 근거: 색인 앞에서 거르는 방식은 비용이 허용 집합 크기에 비례한다(조사 문서의 104ms·50–622ms). 뒤에서
  확인하면 비용이 k에 묶인다. 정확성은 SQLite가 계속 진실이라 잃지 않는다.

### 2. 색인이 아는 것

색인은 벡터마다 **부모 node seq**를 안다. 청크를 부모로 합치는 일과 `beforeSeq` 가지치기를 SQL 없이 한다.

- 활성 embedder는 모든 node를 청크로 나눈다(`embedder.ts:415`). 벡터 id는 `node_vector_chunks.vector_id`다.
  node seq를 id로 쓰는 한 벡터짜리 node는 옛 embedder에만 있다. 새 구조는 청크 id만 다룬다.
- 부모 seq는 segment 파일 옆에 둔다. 시작할 때 `node_vector_chunks`에서 다시 만들 수도 있다(아래 6번).

### 3. 프로젝트마다 partition, 계층 없이

**모든 프로젝트가 자기 partition을 갖는다.** 작은 프로젝트를 한 partition에 모으지 않는다.

- 근거: Qdrant가 작은 tenant를 모으는 것은 shard마다 HNSW 그래프·스레드·복제 같은 고정 비용이 커서다.
  flat segment의 고정 비용은 파일 하나와 작은 머리말뿐이다. 프로젝트는 83개이고, node 수는 301k, 85k,
  70k, 44k, 25k, 14k 순으로 내려가다 대부분 수천 이하다(2026-11-25 로컬 DB). 계층을 두면 "partition으로
  올리기"라는 옮김 작업이 생긴다. 얻는 것이 없다.
- fold로 node의 프로젝트가 바뀌면 그 node의 `node_vectors` 행을 지운다. trigger가 청크 지움을 기록하고,
  indexer가 새 프로젝트 partition에 다시 embed한다. 그 사이 그 node는 의미 검색에서 빠지고 글자 검색으로는
  찾힌다. fold는 가져오기에서만 일어나서 드물다.

### 4. partition 안은 seq 순 segment

- segment는 **32,768개**에서 봉인한다. turbovec은 이 크기(1024묶음 × 32)부터 검색 하나를 여러 스레드로
  나눈다(`SINGLE_QUERY_PARALLEL_MIN_BLOCKS`, turbovec `search.rs:30`). 그래서 봉인된 segment 하나는 스레드
  하나가 읽기에 알맞은 크기다. 병렬은 segment들을 동시에 읽어서 얻는다.
- 봉인된 segment는 **한 번만 쓰고 고치지 않는다**. `.tmp`·fsync·rename으로 쓰고 디렉터리도 fsync한다.
- 새 벡터는 partition마다 작은 tail에 쌓인다. 저장은 바뀐 tail만 쓴다. tail은 **4,096개**(약 1.6MB)에서
  봉인하고, 봉인된 작은 segment가 8개 모이면 하나의 32,768개 segment로 합친다.
- 합칠 때 원래 벡터는 필요 없다. 앱은 `calibrate`를 부르지 않아서 같은 행은 어디서 encode해도 같은 byte다
  (turbovec `lib.rs:738-745`). `packed_codes`·`scales`를 이어 붙여 `from_parts`(`lib.rs:2371`)로 만든다.
  지움 표시된 slot은 이때 버린다.
- segment마다 부모 seq의 최소·최대를 둔다. `beforeSeq` 이하만 담은 segment는 통째로 읽고, 이상만 담은
  segment는 건너뛰고, 걸친 segment만 그 segment 크기의 마스크로 거른다. 다시 embed한 옛 node가 tail로
  들어오면 범위가 겹칠 수 있다. 그래도 맞다. 덜 건너뛸 뿐이다.

### 5. 지움 표시

- 지움 기록(`memory_chunk_vector_removals`, `memory_graph_vector_removals`)은 지금처럼 SQLite에 durable하게
  남는다. 새 구조는 그것을 **기록이 commit된 직후** 메모리의 segment별 지움 표시에 반영한다. 지금처럼 시작할
  때나 그래프 정리 때까지 기다리지 않는다.
- 기록은 그 slot이 든 segment가 합쳐지거나 다시 쓰일 때까지 지우지 않는다. 그래서 시작할 때 지움 표시는
  SQLite 기록에서 다시 만든다. 따로 파일을 두지 않는다.
- 지움 표시는 검색 마스크로 쓰여 확인 SQL에서 떨어질 hit을 미리 줄인다. 정확성은 1번의 확인이 지킨다.

### 6. 일관성과 복구

- 쓰기 순서는 지금과 같다. tail에 넣고, tail을 저장하고, SQL에 commit한다. commit 전에 끝나면 그 벡터는
  확인 SQL에서 떨어지고, 다음 시작에서 `node_vectors` 행이 없는 청크로 지운다(지금 `:277-296`과 같다).
- 시작할 때 segment마다 SQLite와 맞춰 본다. segment의 id 수와 id 합 해시를 그 id들의 `node_vector_chunks`
  행과 비교한다. 다르면 **그 segment만** 버리고 그 node들의 `node_vectors` 행을 지워 다시 embed한다. 지금은
  개수만 비교하고, 다르면 embedder의 색인 전체를 버린다(`native-vector-index.ts:297-324`).
- 읽기는 segment 목록의 snapshot을 잡는다(`Arc`). 봉인된 segment는 바뀌지 않고, tail은 바뀔 때 새 복사본으로
  바꾼다. 읽기는 저장도 쓰기도 기다리지 않는다. publication gate는 읽기 시작을 막지 않게 된다. 1번의
  확인이 commit 전 벡터를 거르기 때문이다. gate는 쓰기끼리의 순서만 지킨다.

### 7. 다른 프로젝트는 후보를 좁혀 읽는다

사용자 결정(2026-11-25): 다른 프로젝트를 다 읽지 않게 하고, 적어도 후보를 좁힌다.

- **segment마다 요약을 둔다.** 봉인할 때 그 segment의 벡터로 구면 k-means를 돌려 중심 64개를 만든다.
  중심마다 소속 수와 가장 먼 소속까지의 각도를 함께 둔다. 앱 쪽 데이터이고 turbovec은 고치지 않는다.
  tail은 작아서 요약 없이 늘 읽는다.
- **segment 점수는 그 segment 중심과 질문의 cosine 중 최댓값이다.** 분할마다 작은 요약을 두고 가장 가까운
  요약점으로 순위를 매기는 방식이다(KRT, https://arxiv.org/abs/2403.01797). 중심 수는 segment 110개 × 64라
  점수 계산은 dot product 7천 번, 1ms 미만이다.
- **점수 순으로 읽고, 다음 segment의 점수가 지금 k번째 결과 점수보다 여유값 이상 낮으면 멈춘다.** 여유값은
  손으로 정하지 않는다. 표본 질문을 전부 읽기로 돌린 결과를 정답으로 삼아, 목표 recall을 만족하는 가장 작은
  값을 고른다(Dai·Kim·Callan 2017의 "전부 읽기가 공짜 정답" 방식, https://www.cs.cmu.edu/~callan/Papers/sigir17-Zhuyun-Dai.pdf).
  목표는 다른 프로젝트 결과의 recall@k 0.95다. 최소·최대로 읽을 segment 수도 둔다.
- **글자 검색 결과를 더한다.** Tantivy는 이미 허용 프로젝트 전부를 싸게 찾는다. 글자로 강하게 맞은 node가 든
  segment는 점수와 상관없이 읽는다. 글자만으로 고르지는 않는다. 의미로만 맞는 기억을 놓치기 때문이다(LADR,
  https://arxiv.org/abs/2307.16779). 글자만 쓰는 고르기는 비교한 방법 중 가장 부정확했다(Taily, 위 Dai 2017).
- **topic node로 고르지 않는다.** 사용자 발언은 94%가 topic에 이어져 있지만 assistant 답변은 5%뿐이다
  (2026-11-25 로컬 DB). topic으로만 고르면 답변 속 기억을 놓친다.
- **안전한 상한으로 건너뛰기는 덤이다.** 중심과 각도 반경으로 그 segment의 최대 cosine 상한을 구할 수 있다.
  768차원에서는 이 상한이 느슨해 잘 건너뛰지 못한다고 알려져 있다(Weber 1998,
  https://www.vldb.org/conf/1998/p194.pdf; Bruch 2024, https://arxiv.org/abs/2401.09350). 상한으로 건너뛴 비율은
  기록만 하고 의지하지 않는다.
- 프로젝트별 분할은 주제가 아니라 출처로 나눈 분할이라 고르기가 덜 정확하다(Kulkarni·Callan,
  https://www.cs.cmu.edu/~callan/Papers/tois15-akulkarni.pdf). 그래서 고르기를 프로젝트가 아니라 segment 안의
  중심 단위로 한다.
- 고른 segment는 여러 스레드로 나눠 읽는다. segment 하나가 엔진 호출 하나이고, 호출 사이마다 기한을 본다.
  기한이 되면 읽은 데까지 확인 SQL을 돌려 돌려준다. 결과에는 고른 segment 수, 읽은 segment 수, 전체 segment
  수를 담는다. 모델에게 무엇을 말할지는 "사양 결정"이다.
- turbovec #203(앞 검색의 k번째 점수를 다음 검색에 넘기기)은 쓰지 않는다. 고친 커밋(`e0093fcf`)이 main에
  합쳐지지 않아 고정한 1.0.0에도 v1.1.2에도 없다. 각 segment의 top-k를 모아 다시 고르면 결과는 같다.

### 8. IVF

지금 하지 않는다. 한 partition이 백만 개 근처가 되면 그 partition 안에만 둔다. 조사 문서의 판단 그대로다.

## 단계

각 단계는 따로 끝나고 따로 효과가 있다.

1. **hit 확인으로 candidate SQL 없애기.** 색인은 지금 파일 하나 그대로 둔다. 시작할 때
   `node_vector_chunks`에서 vector id → (부모 seq, 프로젝트) 표를 메모리에 만들고 publish 때 고친다. 읽기는
   그 표로 slot 마스크를 만들어(hash 조회 없이 비트 연산) 검색하고 hit만 SQL로 확인한다. 지움 표시도 이
   단계에서 넣는다. 50–622ms의 SQL이 사라진다.
2. **프로젝트 partition과 seq segment.** 파일을 partition·segment로 나누고, tail만 저장하고, 작은 segment를
   합친다. segment별 복구를 넣는다. 마스크가 색인 전체 크기에 비례하던 것과 파일 전체 저장이 사라진다.
3. **동시 읽기.** 읽기가 worker의 한 줄을 기다리지 않고 segment snapshot 위에서 돈다. 다른 프로젝트를 기한
   안에서 병렬로 읽고, 일부 결과를 돌려준다.
4. **후보 좁히기.** 봉인 때 segment 요약을 만들고, 점수 순으로 읽다 멈춘다. 여유값은 전부 읽기와 비교해
   정한다. 전부 읽기는 정답 비교용으로 남긴다.
5. **IVF**: partition이 백만 개 근처가 될 때.

## 확인할 것

- `from_parts`로 이어 붙인 index의 검색 결과가 같은 행을 한 번에 넣은 index와 같은지. 단계 2의 첫 테스트다.
- 확인 SQL에서 떨어지는 hit의 비율. 단계 1에서 dev span으로 본다. 늘 0에 가까워야 한다.
- 고르기의 recall@k와 읽은 segment 비율. 단계 4에서 표본 질문으로 전부 읽기와 비교한다.

## 사양 결정

- 2026-11-25: 다른 프로젝트는 다 읽지 않게 하고, 적어도 후보를 좁힌다(7번).
- 2026-11-25: 일부만 읽었을 때 모델의 대응은 검색 범위에 따라 다르다. 좁은 범위면 사용자에게 말하고, 넓은
  범위면 좁혀 다시 찾는다. 검색 범위를 무엇으로 둘지는 열려 있다.
