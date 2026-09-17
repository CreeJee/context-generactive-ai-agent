# Context Generactive Agent (앱)

ChatGPT 계정으로 대화하고, 세션과 프로젝트를 넘어 기억하는 로컬 에이전트의 웹 앱입니다.
서버 로직은 [memory-agent](../../packages/memory-agent/README.md)가 담당하고, 이 앱은 API 라우트와 UI를 제공합니다.

## 실행

루트에서 의존성을 설치합니다.

```bash
vp install
```

React Router 개발 서버를 실행합니다:

```bash
cd apps/agent
vp run dev --host 127.0.0.1 --port 5174
```

- 스크립트 인자는 `--` 없이 넘깁니다. `vp run dev -- --host ...`로 쓰면 `--`까지 전달되어 서버가 뜨지 않습니다.
- 의존성을 바꾼 뒤 처음 실행하면 Vite가 의존성을 다시 번들링하고 페이지를 새로고침합니다. 그 전에 연 페이지가 로딩 상태에 머물면 직접 새로고침하세요.
- ChatGPT 로그인과 모델 호출에는 의존성으로 설치한 codex(`@openai/codex` 0.154.0 고정)를 사용합니다. codex를 따로 설치할 필요가 없고, 전역에 설치된 codex는 쓰지 않습니다.

데이터는 `~/.context-generactive-agent`에 저장됩니다(SQLite, 벡터 인덱스, 임베딩 모델과 Kiwi 모델, codex 홈, 설정, 실행 파일이 푼 `runtime/`).

### 프로덕션 서버와 실행 파일

```bash
cd apps/agent
vp run bundle                         # 의존 패키지 build + react-router build + vp pack → dist/context-agent.mjs
vp run start --port 5175 --no-open    # 번들로 서버 실행(저장소의 네이티브 패키지 사용)
vp run package                        # 의존 패키지 build 뒤 이 기기용 실행 파일 → dist/context-agent-<플랫폼>-<아키텍처>/context-agent
vp run smoke-package                  # 실행 파일을 저장소 밖에서 띄워 확인(codex 116 MB를 한 번 받음)
```

- 실행 파일: `context-agent [폴더] [--port 5173] [--no-open] [--storage <폴더>]`. 폴더(없으면 실행한 위치)를 프로젝트로 추가하고 선택해 브라우저를 엽니다. 홈 폴더나 `/`(Finder 더블클릭)에서 실행하면 프로젝트 없이 엽니다. 앱이 이미 떠 있으면 새로 띄우지 않고 그 앱에서 폴더를 엽니다. `127.0.0.1`에만 열고, 루프백이 아닌 Host는 거부합니다. 에디터용 ACP는 `context-agent acp [--port 5173]`입니다.
- 첫 실행에서 실행 파일 안의 파일을 `~/.context-generactive-agent/runtime/<해시>`에 풀고, 처음 로그인 상태를 볼 때 codex를 받습니다(받는 동안 사이드바에 "받는 중"이 보입니다).
- 빌드는 대상 플랫폼의 기기에서 합니다. Node 26.8.2와 turbovec 빌드용 Rust가 필요하며, 윈도우에서는 MSVC 빌드 도구도 필요합니다. 서명은 ad-hoc만 합니다. 준비물, 릴리스, Linux는 [빌드 가이드](../../docs/building.md)를 봅니다.

## 화면

- 설정(사이드바 위 톱니바퀴):
  - 웹 검색: Kagi 키 등록, 켜기/끄기, 키 삭제. 키는 OS 키체인에만 저장되고 다시 보여주지 않습니다. 켜면 모델이 필요할 때 검색과 페이지 읽기를 하고 호출마다 Kagi에 과금됩니다.
  - MCP: `~/.context-generactive-agent/mcp.json`(공통)과 `<프로젝트>/.mcp.json`에 적힌 서버 목록. "신뢰하고 시작"을 눌러야 시작하고, 설정이 바뀌면 다시 신뢰해야 합니다. MCP 도구 호출은 매번 승인 카드(또는 auto 모드 판정)를 거칩니다.
  - 에이전트: `agents.json`에 적힌 외부 ACP 에이전트(Codex 등). 대화 목록의 "새 대화" 옆 화살표로 그 에이전트와 직접 대화를 시작할 수도 있습니다(대화에 에이전트 이름 배지, 관련 기억을 찾아 함께 보냄). 신뢰하면 모델이 작업을 맡길 수 있고, 맡길 때마다 승인하며 에이전트의 권한 요청도 카드로 묻습니다. 연결이 연속 두 번 실패하면 멈추고 "다시 연결"로 재시도합니다.
  - Skills: 앱 기본 skill, `~/.agents/skills`(공통), `<프로젝트>/.agents/skills`의 skill 목록. 모델이 작업에 맞는 skill을 읽어 따르지만, skill 문구는 승인을 대신하지 않습니다. 기본 skill `draw`는 다이어그램, 차트, 와이어프레임, 아이콘을 SVG 파일로 그립니다(사진, 일러스트는 못 그림). 같은 이름의 skill을 공통이나 프로젝트에 두면 기본 skill 대신 쓰입니다.
  - 가져오기: Claude Code와 Codex CLI가 이 컴퓨터에 남긴 대화를 기억으로 옮깁니다. 발언뿐 아니라 도구 호출과 결과까지 옮겨서 옛 대화도 근거를 따라갈 수 있고, 시각은 그때 보낸 날짜 그대로입니다. "계속 가져오기"를 켜면 5분마다 새로 쌓인 대화를 이어서 읽습니다. 대화가 있던 폴더는 프로젝트로 자동 등록되고(그 폴더의 파일을 에이전트가 읽고 고칠 수 있게 됩니다), 없어진 폴더처럼 등록할 수 없는 것은 이유와 함께 보여줍니다.
- 사이드바: ChatGPT 로그인 상태, 모델과 추론 강도, 프로젝트 선택과 추가(옆 버튼 → 대화상자), 선택한 프로젝트 설정(권한 모드 `매번 묻기`/`자동 판단`, 다른 프로젝트에서 이 기억 찾기, 목록에서 빼기), 대화 목록.
- 프로젝트 목록에서 빼기: 사이드바에서만 사라지고 대화, 기억, 검색은 그대로 남습니다. 같은 폴더를 다시 추가하면 돌아옵니다. 가져오기가 폴더를 자동 등록하므로, 필요 없는 프로젝트는 목록에서 빼면 됩니다.
- 대화 보관: 대화 행에 마우스를 올려 보관 버튼을 누르면 목록에서 빠지고, 목록 아래 "보관함"에서 복원합니다. 보관해도 기억 검색에는 계속 나옵니다. 답변 중이거나 다른 탭이 쓰는 대화는 보관되지 않습니다.
- 기억: 답변이 끝나면 뒤에서 발언의 주제와 정정 또는 취소 관계를 정리합니다(선택한 모델을 가장 낮은 추론 강도로 사용). 나중에 "무엇으로 하기로 했지?"를 물으면 바뀐 결정과 이전 결정을 함께 답하고, 무엇을 정정한 것인지 불분명하면 되묻습니다.
- 대화: 답변 스트리밍 마크다운([streamdown](https://streamdown.ai), 코드 하이라이트와 한글 강조), 도구 호출 카드(인자, 결과, 상태 배지).
- 이미지 첨부: 붙여넣기, 끌어놓기, 첨부 버튼. 입력창 위 카드의 `#N`을 누르면 본문에 참조가 들어가고, 보낸 메시지에서는 `#N` 칩에 마우스를 올려 미리보거나 눌러서 크게 봅니다. 이미지를 못 읽는 모델을 고르면 첨부가 막힙니다.
- Slash 명령: 입력창에 `/`를 치면 `/new`, `/agent`, `/skill`, `/recall`, `/mode`, `/model`, `/settings`, `/cancel`, `/compact`와 이 프로젝트에서 쓸 수 있는 skill 목록이 나옵니다. skill은 `/<이름> 요청`으로 바로 실행하고, 앱 명령과 이름이 같은 skill은 `/skill <이름>`으로 씁니다. ↑/↓로 고르고, Tab으로 채우고, Enter로 실행합니다.
- 컨텍스트: 입력창 아래 상태줄에 마지막 요청이 모델 컨텍스트를 얼마나 썼는지 보입니다. 대화가 컨텍스트의 25%를 넘으면 이미 답한 도구 출력을 비우고 앞 대화를 요약으로 보내며(요약은 답변이 끝난 뒤 미리 만들어 둠), 55%를 넘으면 오래된 메시지를 뺍니다. `/compact`는 기준과 상관없이 바로 줄입니다. 저장된 대화와 기억은 그대로입니다.
- Esc: 입력 중인 글과 이미지를 비우고, 비어 있으면 실행 중인 답변을 멈춥니다. 중지는 서버에 취소를 요청하고, 실제로 멈췄는지 확인해 알려줍니다.
- 답변 중 새로고침이나 탭 닫기는 답변을 멈추지 않습니다. 다시 열면 진행 중인 답변에 이어 붙습니다. 서버가 답변 중에 다시 시작되면 그 답변은 자동으로 다시 실행하지 않고, 끝나지 않았다고 알립니다.
- 비밀 가리기: 도구 결과에 찍힌 API 키, 토큰, 비밀번호는 모델과 화면에 `[redacted:종류]`로 보이고 기억에도 그렇게 남습니다. 직접 붙여 넣은 키는 그 턴의 모델에는 그대로 가지만 기억에는 남지 않습니다. 예전에 저장된 대화도 앱을 시작할 때 뒤에서 한 번씩 정리합니다. 파일에서 키가 가려진 줄은 에이전트가 원문을 볼 수 없어 고칠 수 없습니다.
- 모델이 그린 그림: 기본 skill `draw`로 SVG를 쓰면 도구 카드 아래에 그 순간의 그림이 보이고, 누르면 크게 봅니다.
- 승인 카드: 셸 실행과 프로젝트 밖 쓰기와 삭제를 승인/거부합니다. 자동 판단 모드에서는 분류 모델이 확인을 요청한 경우에만 뜨고, 그 이유를 함께 보여줍니다. 대기 중에 새로고침해도 서버에 저장된 승인 요청으로 카드가 다시 뜹니다.
- 답변 중 메시지: Enter는 대기열에 넣어 다음 도구 호출 때 전달하고, 도구 호출 없이 답변이 끝나면 다음 턴으로 보냅니다. Ctrl(⌘)+Shift+Enter는 답변 중인 턴에 바로 전달(스티어링)합니다. 입력창 위 목록에서 대기 중, 편집 중, 확인 필요, 전달됨, 전달 실패를 구분합니다.
- 대기 메시지 편집: Alt(⌥)+↑/↓ 또는 연필 버튼으로 골라 같은 입력창에서 고칩니다. Enter 저장, Esc는 그 메시지 제거. 편집 중인 메시지와 그 뒤 메시지는 전달되지 않습니다. 중지, 실패, 서버 재시작, 탭 닫기 뒤 남은 메시지는 "확인 필요"가 되고, "보내기"를 눌러야 보냅니다.
- 서브에이전트: 모델이 작업을 서브에이전트에 맡기면 입력창 위에 "작업 중"으로 보이고, 서브에이전트의 셸, 밖 쓰기, MCP 호출은 "일회 서브에이전트: …" 승인 카드로 따로 묻습니다. 대화를 멈추면 서브에이전트도 멈춥니다.
- 여러 탭: 한 대화는 한 탭에서만 쓸 수 있습니다. 다른 탭이 쓰고 있는 대화는 읽기 전용으로 열리고 진행 상황을 따라 보여줍니다. 그 탭이 떠나도 자동으로 넘겨받지 않으며, "이어서 작업"을 누르면 다시 확인해 쓸 수 있게 됩니다.

에디터(Zed 등)에서 같은 대화를 쓰려면 앱을 켠 채 ACP 에이전트 `packages/memory-agent/bin/context-agent-acp.ts`를 등록합니다([설정 예시](../../packages/memory-agent/README.md#에디터에서-쓰기-acp)).

UI 컴포넌트는 shadcn으로 추가합니다(`AGENT.md`).

## API 라우트

`app/routes/api/*`는 React Router flat routes이며 `/api` 접두사로 마운트됩니다. 상태를 바꾸는 요청은 교차 사이트 요청을 거부합니다.

| 라우트                                       | 동작                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET/POST /api/auth`                         | 로그인 상태 조회, `login`, `cancel`, `logout`                                        |
| `GET /api/models`                            | 계정에서 쓸 수 있는 모델 목록과 현재 선택                                            |
| `POST /api/models/:model`                    | 모델과 추론 강도 선택(없는 모델은 자동 대체 없이 오류)                               |
| `GET/POST /api/projects`                     | 프로젝트 목록, 경로로 추가                                                           |
| `GET/POST /api/projects/:project/agents`     | 외부 ACP 에이전트 목록과 연결 상태, `trust`, `reconnect`                             |
| `GET /api/projects/:project/skills`          | 이 프로젝트에서 쓸 수 있는 skill과 읽지 못한 폴더                                    |
| `GET/POST /api/projects/:project/mcp`        | MCP 서버 목록과 상태, `{scope, name, trusted}`로 신뢰/중지                           |
| `POST /api/projects/:project`                | `crossRecallExcluded`, `permissionMode`(`ask`/`auto`) 변경                           |
| `GET/POST /api/sessions`                     | 프로젝트별 대화 목록(`archived=1`이면 보관함), 새 대화(`agent`로 외부 에이전트 직접) |
| `GET /api/sessions/:session?holder=`         | 진행 중인 run, 마지막 run의 끝난 방식, 이 탭의 소유 여부, 컨텍스트 사용량            |
| `POST /api/sessions/:session`                | `{archived}` 보관과 복원(답변 중 409, 다른 탭 사용 중 423)                           |
| `POST /api/sessions/:session/lease`          | 탭의 소유권 얻기, 갱신(`claim`), 놓기(`release`)                                     |
| `POST /api/sessions/:session/cancel`         | 진행 중인 run 취소(소유 탭만), 실제로 멈췄는지 응답                                  |
| `POST /api/sessions/:session/compact`        | `/compact`: 앞 대화 요약, 이미 답한 도구 출력 비우기(답변 중 409)                    |
| `GET/POST /api/sessions/:session/queue`      | 대기열 목록, 답변 중 메시지 넣기(`queue`/`steer`)                                    |
| `POST /api/sessions/:session/queue/:message` | 대기 메시지 편집 내용 저장, 저장, 제거, 확인 후 보내기                               |
| `GET /api/sessions/:session/subagents`       | 서브에이전트 목록과 상태                                                             |
| `GET /api/sessions/:session/approvals`       | run을 멈추지 못하는 승인 대기(서브에이전트, 외부 에이전트)                           |
| `GET /api/sessions/:session/subagents/:id`   | 서브에이전트 대화 기록                                                               |
| `POST .../approvals/:approval`               | 그 호출 승인/거부 `{approved}`(소유 탭만)                                            |
| `GET /api/chat?session=&threadId=`           | 새로고침 복원: 대화, 진행 중인 run, 대기 중인 승인                                   |
| `GET /api/chat?session=&runId=&offset=`      | 진행 중이거나 끝난 run의 답변을 로그에서 다시 읽기                                   |
| `POST /api/chat?session=`                    | 채팅 실행(SSE), 승인 재개 포함(소유 탭만)                                            |
| `GET/POST /api/settings/kagi`                | Kagi 상태, `register`, `enable`, `disable`, `remove`                                 |
| `POST /api/attachments`                      | 이미지 원본 바이트 업로드(png/jpeg/gif/webp, 20 MiB 이하)                            |
| `GET /api/attachments/:attachment`           | 저장된 이미지(다른 사이트 삽입 차단)                                                 |

## 구조

```
app/
  .server/     ManagedRuntime(agent.ts), HTTP 헬퍼
  entry/       화면: 사이드바, 대화, 메시지, 마크다운, 승인 카드, API 클라이언트
  components/  shadcn UI
  routes/      _index.tsx, api/*
server/        프로덕션 진입점: main.ts(CLI/acp), serve.ts(node:http + React Router, Host 검사, 정적 파일),
               runtime-assets.ts(실행 파일 자원 풀기), launch-project.ts(실행 폴더를 프로젝트로 열기)
scripts/       package.ts(실행 파일 만들기), smoke-package.ts(배포물 확인)
```
