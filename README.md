# Context Generactive Agent

세션·프로젝트를 넘어 대화를 기억하고, 근거를 따라갈 수 있는 로컬 에이전트입니다.
ChatGPT 계정(버전을 고정한 codex app-server)으로 모델을 쓰고, 기억은 로컬 SQLite·임베딩·Kiwi 형태소·그래프로 저장하고 찾습니다.
실행 파일 `context-agent` 하나로 배포하며, 실행하면 웹 앱과 에이전트가 함께 뜹니다. 필요한 파일(codex 116 MB, 임베딩·Kiwi 모델 약 230 MB)은 처음 쓸 때 `~/.context-generactive-agent` 아래로 받습니다.

- [apps/agent](apps/agent/README.md): 웹 앱(UI, API 라우트), 실행 방법
- [packages/memory-agent](packages/memory-agent/README.md): 기억·도구·권한·codex 연결
- [docs/decisions.md](docs/decisions.md): 확정한 제품·설계 결정
- [docs/building.md](docs/building.md): 플랫폼별 빌드·릴리스 가이드 (macOS·Windows 릴리스, Linux 로컬 빌드)

## 아키텍처

한 프로세스(`context-agent`) 안에 웹 서버와 에이전트가 함께 돕니다. 서비스는 Effect `Layer`로 조립한 `ManagedRuntime` 하나에 있고, CPU를 오래 쓰는 일(임베딩, 형태소 분석, 다른 에이전트 기록 가져오기)은 worker thread에서 돕니다.

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

### 대화 한 턴

사용자 발언과 모델의 답, 도구 호출과 결과는 모두 원문 그대로 노드가 되고, 구조 edge(`next`, `reply`, `calls`, `returns`, `touches`)로 이어집니다. 검색·인덱싱·해석은 답변을 막지 않도록 뒤에서 돕니다.

```mermaid
sequenceDiagram
  autonumber
  actor User as 사용자
  participant UI as 브라우저
  participant Chat as AgentChat
  participant Codex as codex app-server
  participant Tools as 도구
  participant Mem as 기억(SQLite · turbovec)
  participant BG as 뒤에서 도는 일

  User->>UI: 질문
  UI->>Chat: POST /api/chat
  Chat->>Mem: 사용자 노드 저장
  Chat->>Codex: 턴 시작(도구 정의 · 지침)
  Codex-->>Chat: 도구 호출 find_memory
  Chat->>Tools: 권한 확인 뒤 실행
  Tools->>Mem: 벡터 · FTS · 형태소 순위 → RRF → 그래프 확장
  Mem-->>Tools: 근거 노드 · 정정한 발언
  Tools-->>Chat: 결과(비밀 가림)
  Chat->>Mem: 도구 호출 · 결과 노드 저장
  Chat->>Codex: 결과 전달
  Codex-->>Chat: 답변 스트림
  Chat-->>UI: SSE(끊겨도 이어 받기)
  Chat->>Mem: 답변 노드 저장
  Chat-)BG: 인덱싱(embed-worker · kiwi-worker)
  Chat-)BG: 해석(주제 · 정정 · 취소 edge)
```

### 기억이 쌓이는 길

```mermaid
flowchart LR
  Live["대화 · 도구 결과"] -->|비밀 가리기| Nodes
  Other["Claude Code · Codex CLI 기록"] -->|import-worker<br/>비밀 가리기 · 200개씩 쓰기| Nodes
  Old["예전에 저장된 텍스트"] -->|SecretSweep| Nodes
  Nodes[("nodes · edges")] -->|트리거| FTS[("FTS trigram")]
  Nodes -->|Indexer · 최근 대화부터| Embed["embed-worker"] --> Vec[("turbovec")]
  Nodes -->|Indexer| Kiwi["kiwi-worker"] --> Morph[("형태소 BM25")]
  Nodes -->|Interpreter| Topics["topic 노드<br/>corrects · retracts · related"]
```

## 동작 예시

데모용 프로젝트(`shop-api`)와 Claude Code 대화 두 개로 녹화했습니다.

**다른 에이전트의 대화 가져오기.** 설정의 "가져오기"를 켜면 Claude Code 기록을 읽어 노드로 옮기고, 대화가 있던 폴더를 프로젝트로 등록합니다. 옮긴 노드는 뒤에서 임베딩됩니다("기억" 탭: 메모리 16GB 이상이고 WebGPU가 되면 GPU에서 돕니다). 가져온 대화는 도구 호출과 결과까지 그대로 열립니다.

![가져오기 데모](docs/media/demo-import.gif)

**예전 결정 기억해 내기.** 새 대화에서 물으면 모델이 `find_memory`로 가져온 대화를 찾고, `read_evidence`·`trace_evidence`로 원문과 근거를 따라가 답합니다. 배포 일정은 나중에 바뀐 결정(화요일 → 목요일)으로 답합니다.

![기억 데모](docs/media/demo-recall.gif)

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo in dependency order, turbovec's native addon included (needs Rust; cached by Vite Task):

```bash
pnpm build   # or: vp run build
```

- Run the development server (see [apps/agent](apps/agent/README.md) for host/port options):

```bash
vp run dev
```

- Build the executable for this machine and check it (Node 26.8.2 from `.node-version`):

```bash
cd apps/agent
vp run package
vp run smoke-package
```
