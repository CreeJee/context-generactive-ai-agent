# 벡터 색인 구조 조사 (2026-11-24)

다른 프로젝트까지 기억을 찾으면(`crossProjectRecall`) 기억이 쌓일수록 읽기가 2초 예산을 넘는다. 이 문서는
그 원인을 구조로 보고, 기억 크기와 무관하게 비용이 묶이는 벡터 색인 구조를 조사한 기록이다. 기기 벤치마크가
아니라 구조로 판단한다. 숫자는 출처가 있는 측정만 쓴다.

## 결론

- 비용을 늘리는 것은 벡터를 훑는 일이 아니라 **프로젝트 필터를 SQL에서 만든 id 목록으로 거는 방식**이다.
  turbovec의 4비트 flat scan은 768차원 80만 개에 5.3ms다. 같은 크기에 허용 id 목록을 붙이면 104ms가 되고,
  그 목록을 만드는 SQL은 허용 프로젝트의 node를 종류와 상관없이 전부 훑는다.
- 근본 해법은 **프로젝트를 색인의 물리적 단위로 나누고, 그 안을 seq 범위의 segment로 나누는 것**이다. 필터는
  읽을 segment를 고르는 일이 되고, SQL에서 id 목록을 만들 필요가 없어진다.
- 다른 프로젝트 읽기는 segment마다 차례로 읽고, 사이마다 기한을 본다. 기한이 되면 읽은 데까지 돌려주고
  일부만 읽었다고 알린다. 지금처럼 다른 프로젝트 결과를 통째로 버리지 않는다.
- IVF는 지금 필요 없다. 한 partition이 백만 개를 넘을 때 그 안에만 둔다. 그래프 색인(HNSW, DiskANN)과 외부
  엔진(LanceDB, Faiss)은 쓰지 않는다.

## 지금 구조 (2026-11-24)

경로: `UP` = turbovec upstream(`ccab9f3`), `TV` = `packages/turbovec/src`, `MA` =
`packages/memory-agent/src/memory`.

- turbovec은 TurboQuant 양자화의 flat 색인이다. 학습이 없고, 앱은 4비트를 쓴다
  (`MA/embedding/native-vector-index.ts:120`). 768차원 한 벡터는 약 396B다. full-precision 재정렬은 없다.
- 검색은 모든 32개 묶음을 SIMD로 훑고 top-k를 heap으로 고른다(`UP/search.rs:3192-3243`).
- 허용 id 필터(`UP/id_map.rs:664-713`)는 색인 전체 크기의 마스크를 만들고, 허용 id마다 hash를 찾고, 허용
  slot이 하나라도 있는 묶음을 훑는다. slot은 넣은 순서라 프로젝트가 섞여 있어서, 큰 프로젝트는 거의 모든
  묶음을 건드린다.
- 앱의 읽기 한 번(`TV/read_session.rs`):
  1. candidate SQL(`:465-491`): 허용 프로젝트의 모든 node를 `nodes_project`로 훑으며 벡터 id 목록과
     vector id → node seq 표를 만든다. 실제 앱에서 50–622ms가 걸렸다(`docs/memory-search-measurements.md`).
  2. 벡터 단계(`:495-551`): 청크를 부모 node로 합치며 `vectorK`(최대 48)개 부모가 찰 때까지 다시 검색한다.
     한 번 돌 때마다 전체 크기 마스크를 다시 만든다.
  3. 매핑(`:553-596`): hit의 rowid 조회다. 작다.
- 기한은 협력적으로만 본다. SQL 행마다, SQLite progress handler 1000 op마다, 엔진 호출 앞뒤에서 본다. 엔진
  호출 안은 멈출 수 없다(`TV/search_control.rs:1-6`).
- 지금 프로젝트와 다른 프로젝트 전체를 각각 한 번씩 2초 예산으로 읽는다(`MA/search.ts:700-726`). 다른
  프로젝트 읽기가 넘치면 그 결과를 전부 버린다.
- 저장은 색인 파일 전체를 다시 쓴다(`TV/lib.rs:198-218`). 바쁜 머신에서 32MB 저장이 3.9초 걸렸다. 저장과
  읽기는 같은 worker의 한 줄에서 기다린다.

측정(`docs/decisions.md:4189-4196`, M1 Pro, 4비트, k=48, warm median):

| 색인 크기 | 768d 필터 없음 | 768d 전체 허용 목록 |
| --------- | -------------- | ------------------- |
| 64k       | 0.57ms         | 7.79ms              |
| 200k      | 1.46ms         | 25.01ms             |
| 800k      | 5.34ms         | 104.31ms            |

### 단계별로 무엇에 비례하는가

| 단계             | 비례하는 것                                   |
| ---------------- | --------------------------------------------- |
| candidate SQL    | 허용 프로젝트의 **모든 node**(모든 종류)      |
| 허용 목록 마스크 | **색인 전체 크기**, 청크 합치기 반복마다 다시 |
| SIMD scan        | 허용 slot이 있는 묶음 수                      |
| 매핑             | k                                             |
| 저장             | **색인 전체 크기**(파일 전체를 다시 씀)       |

굵은 셋이 기억 전체 크기에 비례한다. 셋 다 색인 구조가 아니라 필터와 저장 방식에서 나온다.

## 외부 사례

### turbovec과 IVF

- turbovec README: 모든 벡터를 훑고 비용이 크기에 선형이다. 수억 개라면 HNSW나 IVF를 앞에 둬야 한다
  (https://github.com/RyanCodrai/turbovec).
- pg_turbovec은 turbovec 위에 IVF를 얹었다. 1M×1024 4비트에서 flat은 6.08ms에 R@10 1.000, IVF
  (`lists=1024`)는 16.04ms에 recall 0.959가 상한이었다. 규칙: "bit_width ≥ 2, n ≲ 1M → flat"
  (https://github.com/gburd/pg_turbovec).
- turbovec 이슈 #203: 앞 검색의 k번째 점수를 넘겨 다음 검색이 처음부터 가지치기하게 한다. 여러 색인을 차례로
  읽는 용도다(https://github.com/RyanCodrai/turbovec/issues/203). #570은 IVF용 k-means 제안이며 답이 없다.
- TurboQuant가 RaBitQ보다 대부분 설정에서 못하다는 재현 보고가 있다(https://arxiv.org/abs/2604.19528).
  우리 데이터에서 recall이 문제가 되면 같은 배치에 RaBitQ 계열 코드로 바꿀 수 있다.

### 여러 tenant(프로젝트) 나누기

- Qdrant: 작은 tenant는 한 shard를 같이 쓰고 큰 tenant는 자기 shard로 올린다("tiered multitenancy")
  (https://qdrant.tech/documentation/guides/multitenancy/).
- Milvus: partition key, 그리고 key마다 따로 색인을 만드는 "Partition Key Isolation"
  (https://milvus.io/docs/use-partition-key.md).
- Turbopuffer: namespace는 한 번에 여러 개를 읽지 않아도 되는 한에서 작게 한다
  (https://turbopuffer.com/docs/performance).
- 공통 결론: 크기가 제각각인 tenant는 계층으로 나눈다. 큰 것은 자기 partition, 작은 것은 같이 쓰고, 여러
  tenant를 걸치는 질문은 partition마다 읽어 합친다.

### 계속 들어오는 쓰기

- LanceDB: 아직 색인하지 않은 행은 flat으로 읽어 색인 결과와 합친다. `optimize()`는 군집을 옮기지 않으니
  가끔 다시 학습한다
  (https://github.com/lancedb/lancedb/blob/main/docs/web/indexing/incremental-indexing.mdx).
- Milvus: 작은 segment는 brute force로 읽고, 커지면 봉인해 색인한다
  (https://github.com/milvus-io/milvus/blob/master/configs/milvus.yaml).
- Turbopuffer: 쓰기는 log에 먼저 두고 배경에서 색인한다. 색인 전 데이터는 전부 훑는다
  (https://turbopuffer.com/docs/architecture).
- SPFresh/LIRE: partition을 제자리에서 나누고 합쳐 전체 재구축을 피한다(https://arxiv.org/abs/2410.14452).

### 기한 안에서 멈추기

- Faiss `SearchParametersIVF.max_codes`: 군집을 중심 거리 순으로 읽으며 훑을 코드 수에 상한을 둔다
  (https://github.com/facebookresearch/faiss/blob/main/faiss/IndexIVF.h).
- Learned Adaptive Early Termination(SIGMOD 2020), DARTH(SIGMOD 2026), Auncel(NSDI 2023): 질문마다 언제
  멈출지 정한다. 지금 규모에는 과하다.
- 정리: 일을 작은 단위(segment, 군집)로 나누고 단위 사이에서 기한을 보면 읽은 데까지 돌려줄 수 있다.

### 쓰지 않는 것

- HNSW·DiskANN: 좁은 필터에서 정확도가 무너지고(Qdrant 문서), 삭제가 어렵고(Faiss HNSW는 삭제 없음),
  1M×768 float32에서 약 3.3GB를 쓴다.
- LanceDB: SQLite와 같은 원본을 또 두게 되고, native 패키지가 262–356MB다.
- faiss-rs: Faiss 1.7.2에 묶여 TurboQuant·RaBitQ가 없다. Faiss 1.16 C++을 직접 묶는 길은 Windows 빌드가
  무겁다(확인 못 함).
- sqlite-vec: IVF가 실험 단계다(0.1.10-alpha).

## 제안 구조

1. **프로젝트 partition, 계층.** node가 일정 수를 넘는 프로젝트는 자기 partition, 작은 프로젝트는 공유
   partition 하나에 slot마다 프로젝트 표시를 둔다. 지금 프로젝트만 읽는 검색은 그 프로젝트 크기에만 비례한다.
2. **seq 범위 segment.** partition 안을 seq 순서의 봉인된 segment와 작은 tail segment로 나눈다.
   - `beforeSeq`는 segment를 통째로 고르거나 버린다. 경계에 걸친 하나만 마스크로 거른다.
   - 저장은 tail segment만 다시 쓴다. 봉인된 segment는 바뀌지 않는다(삭제는 작은 tombstone 표).
3. **색인이 부모와 프로젝트를 안다.** slot마다 부모 node seq를 두면 청크 합치기에 SQL 표가 필요 없다.
   candidate SQL은 사라진다. 대신 색인과 SQL이 같은 것을 담는다는 보장(지금의 publication gate)이
   segment 단위로 옮겨 가야 하고, 대기 중인 삭제(`memory_graph_vector_removals`)를 읽기 전에 반영해야 한다.
4. **기한 있는 fan-out.** 지금 프로젝트 → 다른 프로젝트(최근 것부터) 순서로 segment를 읽고, 앞의 k번째
   점수를 다음 검색에 넘긴다(#203). segment 사이마다 기한을 보고, 넘치면 읽은 데까지와 "일부"를 돌려준다.
   엔진 호출 하나가 segment 하나라 지금의 멈출 수 없는 호출과도 맞는다.
5. **IVF는 나중에, partition 안에만.** 한 partition이 백만 개 근처가 되면 그 안에 둔다. 코드는 잔차가 아닌
   원래 벡터로 만들어 군집을 다시 학습해도 다시 양자화하지 않게 한다. 군집마다 프로젝트 bitmap, 군집 중심
   거리 순 읽기, tail flat 검색을 둔다.

## 열린 질문

- 프로젝트가 자기 partition을 갖는 기준(node 수).
- segment 봉인 크기. 저장 시간과 segment 수(= fan-out 단위 수)의 균형이다.
- candidate SQL을 없애면 색인과 SQL의 일치를 어떻게 보장할지. 지금 publication gate와 복구 절차
  (`MA/embedding/native-vector-index.ts:236-324`)를 segment 단위로 다시 짜야 한다.
- #203이 고정한 turbovec rev(`ccab9f3`)에 있는지, 없으면 올릴지.
- 일부만 읽었을 때 모델에게 무엇을 알릴지(`degraded`의 새 값 또는 `otherProjectsSkipped`의 모양).

기술 질문의 답은 `docs/vector-index-design.md`(2026-11-25)에 있다.
