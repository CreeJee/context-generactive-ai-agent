# Context Generactive Agent

세션과 프로젝트를 넘어 대화를 기억하고, 근거를 따라갈 수 있는 로컬 에이전트입니다.

버전을 고정한 codex app-server를 통해 ChatGPT 계정으로 모델을 사용합니다. 기억은 로컬 SQLite에 저장하고, 벡터 임베딩과 Kiwi 형태소 분석, 그래프로 찾습니다.

실행 파일 `context-agent` 하나로 배포합니다. 파일을 실행하면 웹 앱과 에이전트가 함께 시작됩니다.

설정 파일 위치: `~/.context-generactive-agent`

- [apps/agent](apps/agent/README.md): 웹 앱(UI, API 라우트), 실행 방법
- [packages/memory-agent](packages/memory-agent/README.md): 기억, 도구, 권한, codex 연결
- [docs/decisions.md](docs/decisions.md): 확정한 제품과 설계 결정
- [docs/building.md](docs/building.md): 플랫폼별 빌드와 릴리스 가이드 (macOS와 Windows 릴리스, Linux 로컬 빌드)

## 아키텍처

웹 서버와 에이전트는 한 프로세스(`context-agent`)에서 실행됩니다. Effect `Layer`로 서비스를 조립하고 `ManagedRuntime` 하나로 관리합니다. 임베딩과 형태소 분석, 다른 에이전트의 기록 가져오기는 worker thread에서 처리합니다.

```mermaid
flowchart TB
  Web["브라우저<br/>대화 · 사이드바 · 설정"] --> Routes
  Editor["에디터<br/>context-agent acp"] --> Routes

  subgraph App["context-agent 프로세스"]
    Routes["API 라우트 /api/*"] --> Chat

    subgraph Run["대화 실행"]
      Chat["AgentChat<br/>TanStack AI chat()"]
      MW["middleware<br/>ChatState · 대기열 · 권한 게이트<br/>서브에이전트 · Recorder"]
      Tools["도구<br/>기억 · 파일 · 셸 · 웹 검색 · MCP · skill · 위임"]
      Chat --- MW
      Chat --- Tools
    end

    subgraph Memory["기억 서비스"]
      Search["MemorySearch<br/>벡터 · FTS · 형태소 → RRF → 그래프"]
      Indexer["Indexer"]
      Interp["Interpreter<br/>주제 · 정정 · 취소"]
      Importer["Importer"]
      Sweep["SecretSweep"]
    end

    subgraph Workers["worker threads"]
      Embed["embed-worker<br/>ONNX · CPU 또는 WebGPU"]
      Kiwi["kiwi-worker<br/>한국어 형태소"]
      ImportW["import-worker<br/>기록 읽기 · 비밀 가리기 · 대량 쓰기"]
    end

    Tools --> Search
    Indexer --> Embed
    Indexer --> Kiwi
    Importer --> ImportW
  end

  Codex["codex app-server<br/>ChatGPT 계정"]
  External["MCP 서버 · 외부 ACP 에이전트 · Kagi"]
  Transcripts["~/.claude · ~/.codex 기록"]

  subgraph Storage["~/.context-generactive-agent"]
    DB[("agent.db (SQLite)<br/>nodes · edges · FTS · chat state")]
    Vec[("turbovec 벡터 인덱스")]
    Models[("임베딩 · Kiwi 모델")]
  end

  Chat <--> Codex
  Interp <--> Codex
  Tools --> External
  ImportW --> Transcripts
  MW --> DB
  Memory --> DB
  Search --> Vec
  Indexer --> Vec
  ImportW --> DB
  Embed --> Models
  Kiwi --> Models
```

### 대화 루프

사용자 발언과 모델 답변, 도구 호출과 결과를 원문 그대로 노드에 저장합니다. 노드는 구조 edge(`next`, `reply`, `calls`, `returns`, `touches`)로 연결됩니다. 벡터 색인에는 발언만 넣고, 도구 노드는 글자 검색과 연결된 edge로 찾습니다.

```mermaid
sequenceDiagram
  autonumber
  actor User as 사용자
  participant UI as 브라우저
  participant Chat as AgentChat
  participant Codex as codex app-server
  participant Tools as 도구
  participant Mem as 기억(SQLite + turbovec)
  participant BG as 뒤에서 도는 일

  User->>UI: 질문
  UI->>Chat: POST /api/chat
  Chat->>Mem: 사용자 노드 저장
  Chat->>Codex: 턴 시작(도구 정의 및 지침)
  Codex-->>Chat: 도구 호출 find_memory
  Chat->>Tools: 권한 확인 뒤 실행
  Tools->>Mem: 벡터 / FTS / 형태소 순위 → RRF → 그래프 확장
  Mem-->>Tools: 근거 노드 / 정정한 발언
  Tools-->>Chat: 결과(비밀 가림)
  Chat->>Mem: 도구 호출 / 결과 노드 저장
  Chat->>Codex: 결과 전달
  Codex-->>Chat: 답변 스트림
  Chat-->>UI: SSE(끊겨도 이어 받기)
  Chat->>Mem: 답변 노드 저장
  Chat-)BG: 인덱싱(embed-worker / kiwi-worker)
  Chat-)BG: 해석(주제 / 정정 / 취소 edge)
```

### 기억이 쌓이는 길

```mermaid
flowchart LR
  Live["대화 · 도구 결과"] -->|비밀 가리기| Nodes
  Other["Claude Code · Codex CLI 기록"] -->|import-worker<br/>비밀 가리기 · 200개씩 쓰기| Nodes
  Old["예전에 저장된 텍스트"] -->|SecretSweep| Nodes
  Nodes[("nodes · edges")] -->|트리거| FTS[("FTS trigram")]
  Nodes -->|Indexer · 발언만, 최근 대화부터| Embed["embed-worker"] --> Vec[("turbovec")]
  Nodes -->|Indexer| Kiwi["kiwi-worker"] --> Morph[("형태소 BM25")]
  Nodes -->|Interpreter| Topics["topic 노드<br/>corrects · retracts · related"]
```

## 동작 예시

데모용 프로젝트(`shop-api`)와 Claude Code 대화 두 개로 녹화했습니다.

설정의 "가져오기"를 켜면 Claude Code 기록을 읽어 노드로 옮기고, 대화가 있던 폴더를 프로젝트로 등록합니다. 가져온 발언은 백그라운드에서 임베딩합니다. 실행 방식은 "기억" 탭에서 확인할 수 있으며, 메모리가 16GB 이상이고 WebGPU를 사용할 수 있으면 GPU에서 처리합니다. 도구 호출과 결과는 임베딩하지 않고 글자 검색과 형태소 검색과 발언에서 이어진 edge로 찾습니다. 가져온 대화는 도구 호출과 결과까지 그대로 열립니다.

![가져오기 데모](docs/media/demo-import.gif)

새 대화에서 예전 결정을 물으면 모델이 `find_memory`로 가져온 대화를 찾고, `read_evidence`, `trace_evidence`로 원문과 근거를 따라가 답합니다. 배포 일정은 나중에 바뀐 결정(화요일 → 목요일)으로 답합니다.

![기억 데모](docs/media/demo-recall.gif)

## Development

개발 준비 상태를 확인합니다:

```bash
vp run ready
```

테스트를 실행합니다:

```bash
vp run -r test
```

turbovec 네이티브 애드온을 포함해 모노레포를 의존성 순서로 빌드합니다. Rust가 필요하며, 빌드 결과는 Vite Task가 캐시합니다:

```bash
pnpm build   # or: vp run build
```

개발 서버를 실행합니다. 호스트와 포트 옵션은 [apps/agent](apps/agent/README.md)를 참고하세요:

```bash
vp run dev
```

현재 기기용 실행 파일을 빌드하고 확인합니다. Node 버전은 `.node-version`에 지정된 26.8.2입니다:

```bash
cd apps/agent
vp run package
vp run smoke-package
```
