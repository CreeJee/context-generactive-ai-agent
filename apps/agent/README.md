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
- 이미지 첨부: 붙여넣기·끌어놓기·첨부 버튼. 입력창 위 카드의 `#N`을 누르면 본문에 참조가 들어가고, 보낸 메시지에서는 `#N` 칩에 마우스를 올려 미리보거나 눌러서 크게 봅니다. 이미지를 못 읽는 모델을 고르면 첨부가 막힙니다.
- Esc: 입력 중인 글·이미지를 비우고, 비어 있으면 실행 중인 답변을 멈춥니다. 중지는 서버에 취소를 요청하고, 실제로 멈췄는지 확인해 알려줍니다.
- 답변 중 새로고침·탭 닫기는 답변을 멈추지 않습니다. 다시 열면 진행 중인 답변에 이어 붙습니다. 서버가 답변 중에 다시 시작되면 그 답변은 자동으로 다시 실행하지 않고, 끝나지 않았다고 알립니다.
- 승인 카드: 셸 실행과 프로젝트 밖 쓰기·삭제를 승인/거부합니다. 자동 판단 모드에서는 분류 모델이 확인을 요청한 경우에만 뜨고, 그 이유를 함께 보여줍니다. 대기 중에 새로고침해도 서버에 저장된 승인 요청으로 카드가 다시 뜹니다.
- 답변 중 메시지: Enter는 대기열에 넣어 다음 도구 호출 때 전달하고, 도구 호출 없이 답변이 끝나면 다음 턴으로 보냅니다. Ctrl(⌘)+Shift+Enter는 답변 중인 턴에 바로 전달(스티어링)합니다. 입력창 위 목록에서 대기 중·편집 중·확인 필요·전달됨·전달 실패를 구분합니다.
- 대기 메시지 편집: Alt(⌥)+↑/↓ 또는 연필 버튼으로 골라 같은 입력창에서 고칩니다. Enter 저장, Esc는 그 메시지 제거. 편집 중인 메시지와 그 뒤 메시지는 전달되지 않습니다. 중지·실패·서버 재시작·탭 닫기 뒤 남은 메시지는 "확인 필요"가 되고, "보내기"를 눌러야 보냅니다.
- 여러 탭: 한 대화는 한 탭에서만 쓸 수 있습니다. 다른 탭이 쓰고 있는 대화는 읽기 전용으로 열리고 진행 상황을 따라 보여줍니다. 그 탭이 떠나도 자동으로 넘겨받지 않으며, "이어서 작업"을 누르면 다시 확인해 쓸 수 있게 됩니다.

UI 컴포넌트는 shadcn으로 추가합니다(`AGENT.md`).

## API 라우트

`app/routes/api/*`는 React Router flat routes이며 `/api` 접두사로 마운트됩니다. 상태를 바꾸는 요청은 교차 사이트 요청을 거부합니다.

| 라우트                                       | 동작                                                       |
| -------------------------------------------- | ---------------------------------------------------------- |
| `GET/POST /api/auth`                         | 로그인 상태 조회, `login`·`cancel`·`logout`                |
| `GET /api/models`                            | 계정에서 쓸 수 있는 모델 목록과 현재 선택                  |
| `POST /api/models/:model`                    | 모델·추론 강도 선택(없는 모델은 자동 대체 없이 오류)       |
| `GET/POST /api/projects`                     | 프로젝트 목록, 경로로 추가                                 |
| `POST /api/projects/:project`                | `crossRecallExcluded`, `permissionMode`(`ask`/`auto`) 변경 |
| `GET/POST /api/sessions`                     | 프로젝트별 대화 목록, 새 대화                              |
| `GET /api/sessions/:session?holder=`         | 진행 중인 run, 마지막 run의 끝난 방식, 이 탭의 소유 여부   |
| `POST /api/sessions/:session/lease`          | 탭의 소유권 얻기·갱신(`claim`)·놓기(`release`)             |
| `POST /api/sessions/:session/cancel`         | 진행 중인 run 취소(소유 탭만), 실제로 멈췄는지 응답        |
| `GET/POST /api/sessions/:session/queue`      | 대기열 목록, 답변 중 메시지 넣기(`queue`/`steer`)          |
| `POST /api/sessions/:session/queue/:message` | 대기 메시지 편집 내용 저장·저장·제거·확인 후 보내기        |
| `GET /api/chat?session=&threadId=`           | 새로고침 복원: 대화, 진행 중인 run, 대기 중인 승인         |
| `GET /api/chat?session=&runId=&offset=`      | 진행 중이거나 끝난 run의 답변을 로그에서 다시 읽기         |
| `POST /api/chat?session=`                    | 채팅 실행(SSE), 승인 재개 포함(소유 탭만)                  |
| `POST /api/attachments`                      | 이미지 원본 바이트 업로드(png/jpeg/gif/webp, 20 MiB 이하)  |
| `GET /api/attachments/:attachment`           | 저장된 이미지(다른 사이트 삽입 차단)                       |

## 구조

```
app/
  .server/     ManagedRuntime(agent.ts), HTTP 헬퍼
  entry/       화면: 사이드바, 대화, 메시지, 마크다운, 승인 카드, API 클라이언트
  components/  shadcn UI
  routes/      _index.tsx, api/*
```
