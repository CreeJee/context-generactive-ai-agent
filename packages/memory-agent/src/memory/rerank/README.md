# rerank

## Overview

검색 결과의 순서를 로컬 cross-encoder reranker로 다시 정하는 계층이다. 모델은 `nlpai-lab/KURE-Reranker-nano`(ModernBERT, 한국어·영어)다. 원본은 safetensors만 공개해서 ONNX로 export한 `CreeJee/KURE-Reranker-nano-ONNX`를 쓴다. 모델은 worker thread에서 WebGPU로 돈다(transformers.js, onnxruntime-node). `MemorySearch.find`는 `rerank`가 켜진 검색에서 seed의 순서를 이 reranker에 맡긴다.

## Interface

- `Reranker` — `Context.Service<Reranker, RerankerApi>`(키 `memory-agent/memory/rerank/reranker`).
  - `Reranker.local`: 로컬 임베더가 gpu 모드일 때 `localGpu`이고, 아니면 `none`이다. CPU를 고른 사용자와 테스트·평가 임베더(runtime `other`)는 reranker가 없다.
  - `Reranker.localGpu`: 임베더와 상관없이 WebGPU reranker를 띄운다. 평가가 사본 위에서 쓴다.
  - `Reranker.none`: 언제나 None을 돌려준다.
- `RerankerApi.score(query, texts)` — text마다 relevance 점수 하나를 순서대로 돌려준다(클수록 관련). 아직 적재 중이거나, 이 기기에서 돌지 않거나, 실패했거나, 예산을 넘기면 None이다.
- `RerankerApi.retry` — 적재에 실패해 꺼진 reranker를 백그라운드에서 다시 적재한다. 꺼져 있지 않으면 아무것도 하지 않는다. 다운로드가 실패했을 때 화면의 '다시 시도'가 `EmbeddingSetup.retryDownload`를 거쳐 부른다.
- `rerankModel` — 모델 id, 파일(`model_fp16`), 쌍당 token(192), 쌍을 자르는 방식(`pairCut`).
- `PairCut` / `pairTokens` / `paddedBatch` (`pairs.ts`) — 쌍이 모델이 읽는 token보다 길 때 자르는 방식(`head`: 이은 쌍의 끝을 자른다. `longest-first`: 긴 쪽부터 줄이고 특수 token은 남긴다. `query-share`: 질문은 특수 token을 뺀 자리의 `share`만큼까지만 쓴다), 그 방식으로 만든 쌍마다의 token id, 가장 긴 쌍에 맞춰 padding한 batch(`input_ids`, `attention_mask`). worker와 평가(`eval/search-set/rerank-inputs.ts`)가 같이 쓴다.
- `RerankRpcs` (`Load`, `Score`) / `RerankWorkerData` / `RerankWorkerFailed` — 호스트와 `rerank-worker.ts` 사이의 RpcGroup 프로토콜, 시작 데이터, `stage: load|run|lost` 실패 타입. `Load`는 stream이다. 모델 파일을 내려받는 동안 `RerankLoadEvent.downloading{loaded, total}`을 보내고, 적재가 끝나면 `loaded`를 보내고 끝난다. 호스트는 진행을 `ModelDownloads`(`../embedding/downloads.ts`)에 `rerank` 용도로 보고한다.
- `rerank-worker.ts` — worker thread 진입점. `runtimeWorker("rerank-worker")`로 실행되고 `RpcServer.layer(RerankRpcs, { concurrency: 1 })`을 띄운다.
- 하위 디렉터리 없음.

## Invariants

- 모델은 layer를 만들 때 백그라운드로 적재한다. 처음 시작하면 모델(299 MB)을 `<storage>/models`에 내려받는다. 검색은 적재를 기다리지 않고, 그동안은 fused 순서를 쓴다.
- WebGPU에서만 돈다. CPU에서는 한 검색의 batch가 몇 초씩 걸려 검색이 기다릴 수 있는 시간을 넘는다(docs/memory-search-measurements.md "rerank"). WebGPU에서 적재하지 못하면 앱을 다시 시작하거나 `retry`할 때까지 rerank를 끈다. worker를 잃어도(`lost`) 마찬가지다. 적재 시도마다 worker를 자기 Scope에 두고, 실패한 시도의 Scope는 닫는다. 요청 하나의 실패(`run`)는 그 검색만 fused 순서로 둔다.
- 모델은 쌍(`<s> 질문 </s> 글 </s>`)의 `maxTokens`(192) token만 읽는다. worker는 tokenizer가 자르게 두지 않고 `pairTokens`로 쌍의 token id를 직접 만든다(transformers.js는 tokenizer 파일의 `truncation_strategy`를 따르지 않고 이은 쌍의 끝만 자른다). 질문과 글마다 그 token을 담는 앞부분만 tokenizer에 넘긴다. 앞부분은 공백 앞에서 자르고(tokenizer는 공백에서 늘 낱말을 끝내므로 앞부분의 token은 전체 글의 앞 token과 같다), `maxTokens`자부터 두 배씩 늘려 token이 `maxTokens`개 이상 담길 때까지 고른다. 글 전체를 tokenizing하면 100 KB에 약 1초, 800 KB에 8초가 걸렸다.
- 모델이 읽는 token이 같은 쌍은 한 번만 점수를 매기고 그 점수를 나눠 준다. `head`에서 질문이 192 token보다 길면 모든 쌍이 질문만 읽어 같아진다(최근 사용자 턴 셋을 이은 retrieval 질문에서 흔하다).
- worker는 한 번에 요청 하나만 처리한다. ONNX 추론은 그 자리에서 중단할 수 없어서 batch는 끝까지 돈다. 검색은 점수를 2초(검색의 native read 예산)까지 기다린다. 넘기면 아직 worker를 기다리던 요청은 버리고, 돌던 batch는 혼자 끝난다.
- 유휴 worker는 `unref` 상태이고, 작업 중에만 `ref`한다. 모델의 `dispose()`는 worker Scope finalizer에 등록된다.
- worker는 `env.allowLocalModels = false`로 동작한다. 첫 실행(짧은 쌍 하나)이 성공해야 적재로 본다.
