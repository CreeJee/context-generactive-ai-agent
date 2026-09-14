# Context Generactive Agent (앱)

ChatGPT 계정으로 대화하고, 세션·프로젝트를 넘어 기억하는 로컬 에이전트의 웹 앱입니다.
서버 로직은 [memory-agent](../../packages/memory-agent/README.md)에 있고, 이 앱은 API 라우트와 UI를 담당합니다.

## 실행

루트에서 의존성을 설치합니다.

```bash
vp install
```

개발 서버(React Router dev):

```bash
cd apps/agent
vp run dev --host 127.0.0.1 --port 5174
```

- 스크립트 인자는 `--` 없이 넘깁니다. `vp run dev -- --host ...`로 쓰면 `--`까지 전달되어 서버가 뜨지 않습니다.
- 의존성이 바뀐 뒤 처음 띄우면 Vite가 의존성을 다시 묶으며 페이지를 새로고침합니다. 그 전에 연 페이지가 로딩 중에 멈춰 보이면 새로고침하세요.
- `codex` CLI가 설치되어 있어야 ChatGPT 로그인과 모델 호출이 됩니다.

데이터는 `~/.context-generactive-agent`에 저장됩니다(SQLite, 벡터 인덱스, 임베딩 모델, codex 홈, 설정).

## 화면

- 사이드바: ChatGPT 로그인 상태, 모델·추론 강도, 프로젝트 선택·추가, 권한 모드(`매번 묻기`/`자동 판단`), 대화 목록.
- 대화: 답변 스트리밍 마크다운([streamdown](https://streamdown.ai), 코드 하이라이트·한글 강조), 도구 호출 카드(인자·결과·상태 배지).
- 승인 카드: 셸 실행과 프로젝트 밖 쓰기·삭제를 승인/거부합니다. 자동 판단 모드에서는 분류 모델이 확인을 요청한 경우에만 뜨고, 그 이유를 함께 보여줍니다.

UI 컴포넌트는 shadcn으로 추가합니다(`AGENT.md`).

## API 라우트

`app/routes/api/*`는 React Router flat routes이며 `/api` 접두사로 마운트됩니다. 상태를 바꾸는 요청은 교차 사이트 요청을 거부합니다.

| 라우트                                | 동작                                                       |
| ------------------------------------- | ---------------------------------------------------------- |
| `GET/POST /api/auth`                  | 로그인 상태 조회, `login`·`cancel`·`logout`                |
| `GET /api/models`                     | 계정에서 쓸 수 있는 모델 목록과 현재 선택                  |
| `POST /api/models/:model`             | 모델·추론 강도 선택(없는 모델은 자동 대체 없이 오류)       |
| `GET/POST /api/projects`              | 프로젝트 목록, 경로로 추가                                 |
| `POST /api/projects/:project`         | `crossRecallExcluded`, `permissionMode`(`ask`/`auto`) 변경 |
| `GET/POST /api/sessions`              | 프로젝트별 대화 목록, 새 대화                              |
| `GET /api/sessions/:session/messages` | 저장된 대화를 UIMessage로                                  |
| `POST /api/chat?session=`             | 채팅 실행(SSE), 승인 재개 포함                             |

## 구조

```
app/
  .server/     ManagedRuntime(agent.ts), HTTP 헬퍼
  entry/       화면: 사이드바, 대화, 메시지, 마크다운, 승인 카드, API 클라이언트
  components/  shadcn UI
  routes/      _index.tsx, api/*
```
