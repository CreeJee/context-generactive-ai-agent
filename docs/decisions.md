# 결정 기록

이 저장소에서 확정한 제품·설계 결정입니다. 새 결정은 날짜와 함께 아래에 추가하고, 뒤집힌 결정은 지우지 말고 "변경"으로 남깁니다.
요구사항의 원본은 이전 프로젝트(`topic-generactive-ai-agent`)의 PRD R01–R19이며, 여기서는 그중 이 저장소에서 바꾸거나 구체화한 부분만 적습니다.

## 범위와 구조 (2026-09-13)

- PRD 전체(R01–R19)를 단계별로 옮기되, 연구용 계약(예산 원장, r00x 평가 등)은 가져오지 않고 직관적인 구조로 다시 만든다.
- `apps/agent`는 React Router(framework mode) 라우트와 UI, `packages/memory-agent`는 서버 로직, `packages/turbovec`는 벡터 인덱스 네이티브 모듈.
- 스택: Effect.ts(서비스·Layer·타입 있는 오류) + Effect Schema. TanStack AI 도구 스키마는 `toToolSchema`로 Standard JSON Schema를 붙여 넘긴다.
- workspace는 `pwd`가 아니라 UI에서 추가·선택하는 프로젝트. 세션·기억·권한 설정은 프로젝트에 속한다.
- 저장 루트는 `~/.context-generactive-agent`.

## 인증과 모델 (2026-09-13)

- ChatGPT OAuth를 codex app-server(JSON-RPC over stdio)로 쓴다. 토큰은 codex가 관리하고 앱은 읽지 않으며, API 키로 재사용하지 않는다.
- 모델은 로그인 후 계정에서 쓸 수 있는 목록에서 사용자가 고른다. 없는 모델은 자동 대체하지 않고 오류.
- 모델 호출은 `CodexTextAdapter`(TanStack 어댑터)로 하고, 도구는 `dynamicTools`로 넘겨 `item/tool/call`을 TanStack 도구 실행으로 연결한다. code mode 전용 모델(gpt-5.6 계열)을 위해 `features.code_mode_host`를 끄지 않는다.

## 기억 (2026-09-13)

- 사용자·assistant·tool call·tool result를 모두 수정 불가 노드로 저장한다. 목적은 근거 추적.
- 채팅은 그래프 구조를 가진다: 저장 시 구조 edge(`next`, `reply`, `calls`, `returns`, `touches`), 이후 LLM 해석(`llm-interpret`)으로 의미 edge(about, corrects, retracts, related)를 보강한다.
- 검색은 turbovec 벡터 순위 + SQLite FTS trigram 순위를 RRF(k=60)로 합친 뒤 그래프를 탐색한다.
- 임베딩은 로컬 모델 `ibm-granite/granite-embedding-97m-multilingual-r2`(fp32, CLS pooling). 모델 파일은 `~/.context-generactive-agent/models`.

## 로컬 도구 (2026-09-14)

- 파일·셸 도구는 codex 내장 도구(셸·apply_patch·샌드박스)가 아니라 **TanStack 도구로 직접 구현**한다(방식 A).
  - 이유: PRD 권한 규칙(밖 읽기는 허용·자격 증명 거부, 셸은 승인)을 그대로 지키고, 모든 호출이 같은 기록 경로로 기억에 들어가며, 백엔드(ACP 등)가 바뀌어도 도구가 남는다.
  - 대가: 셸은 호스트에서 격리 없이 실행된다.
- 프로젝트 파일 변경은 승인 없이 하되, 읽을 때 받은 sha256과 현재 내용이 같을 때만 쓴다(사용자 편집 보존).
- 숨김 파일은 허용하고 `.git` 내부와 자격 증명으로 보이는 경로만 막는다(`tokens.ts`, `password-reset.tsx` 같은 코드는 허용).
- 밖 읽기 도구는 PRD의 `read_outside_file`·`search_outside_file`에 더해 `list_outside_files`를 둔다. 파일 이름을 모르면 읽을 수 없어서.
- 셸 명령에는 비밀로 보이는 환경 변수(`TOKEN`, `API_KEY` 등)를 넘기지 않는다.

## 권한 모드 (2026-09-14)

- PRD R05의 "지속 승인"(프로젝트+정확한 명령 저장) 대신 **auto 권한 모드**를 만든다. Claude Code의 auto 모드와 같은 방식.
  - 프로젝트마다 `ask`(호출마다 사용자 승인, 기본)와 `auto`(분류 모델 판정)를 고른다.
  - auto: 승인이 필요한 호출마다 선택한 모델의 가장 낮은 추론 강도로 `allow`/`ask`/`block`을 받는다. 입력은 호출 내용·실제 사용자 발언·프로젝트 경로뿐이고 도구 결과는 넣지 않는다(프롬프트 인젝션 방지). 실패·timeout은 `ask`.
  - 판정과 사용자 답은 기록하고 도구 결과 노드에 근거로 남긴다.
  - 한 번에 여러 호출 중 하나라도 `ask`면 묶음 전체를 한 번에 묻는다(TanStack 재개 단위).
- **PRD R05 변경**: 사용자가 프로젝트에서 auto 모드를 켠 것은 그 프로젝트의 셸·밖 쓰기를 분류 모델 판정에 맡긴다는 명시적 상시 동의로 본다. 자격 증명·`.git` 규칙과 문서·도구 출력으로 권한이 생기지 않는 원칙은 그대로다.
- 명령 단위 지속 승인은 보류한다.

## UI (2026-09-14)

- 답변은 streamdown으로 스트리밍 마크다운 렌더링한다. 플러그인은 코드 하이라이트(`@streamdown/code`)와 한글 강조(`@streamdown/cjk`)만 쓴다. shadcn의 AI Elements `message`는 Vercel AI SDK 타입과 mermaid·수식 의존이 따라와서 쓰지 않는다.
- 답변 속 이미지는 streamdown 기본대로 표시한다. 원격 이미지는 렌더링 순간 요청이 나가므로, 도구 결과를 통한 URL 유출 위험이 있다는 점을 알고 선택했다. 링크는 이동 전에 확인한다.

## 이미지 첨부 (2026-09-14)

- Claude식 `#1`·`#2` 참조와 Slack식 첨부 목록을 합친다. 붙여넣기·끌어놓기·첨부 버튼으로 넣고, 입력창 위 카드(shadcn `attachment`)에 번호·상태·제거를 보여준다.
  - 번호는 작성 중인 초안 안에서만 매기며(PRD), 이미지를 빼도 초안 번호는 그대로 두고 보낼 때 실제 순서로 다시 매긴다.
  - 보낸 메시지는 본문의 `#N` 칩(hover 미리보기)과 이미지 그리드로 보여준다.
- 첨부하는 즉시 올린다(`POST /api/attachments`). 서버는 바이트 서명으로 형식(png/jpeg/gif/webp, 20 MiB 이하)을 확인해 sha256 이름으로 한 번만 저장한다. 메시지에는 첨부 URL만 싣는다(TanStack이 요청마다 대화 전체를 다시 보내므로).
- codex에는 이번 턴 이미지를 `localImage`, 이전 턴 이미지를 `input_image`(data URL)로 넘긴다. 우리 첨부가 아닌 이미지 URL은 넘기지 않는다.
- 선택한 모델의 `inputModalities`에 이미지가 없으면 첨부를 막고 서버도 거부한다(R06: 읽지 못한 이미지를 읽은 것처럼 보이지 않게).
- 끌어놓기는 브라우저 기본 drop 이벤트로 받는다. dnd-kit은 페이지 안 요소 정렬용이라 OS 파일 drop에는 맞지 않고, 첨부 순서 바꾸기가 필요해지면 그때 쓴다.

## 대화 상태 (2026-09-14)

- 새로고침·탭 닫기 뒤 복원은 서버가 권위를 갖는다. TanStack AI의 `@tanstack/ai-persistence`(`withPersistence` + `reconstructChat`)를 쓰고, 저장소는 앱 SQLite에 직접 구현한다.
  - 이유: 승인 대기처럼 클라이언트 메모리에만 있던 상태가 새로고침으로 사라졌다. 브라우저 저장소는 다른 탭·기기와 어긋나고, TanStack이 run·interrupt 계약과 conformance 테스트를 이미 제공한다.
- TanStack threadId는 세션 id로 고정한다. 한 세션에 대화 하나.
- chat state는 화면 복원용이다. 기억·근거의 원본은 `nodes`이고, chat state가 없는 세션은 노드에서 대화를 만든다.
- UI가 따로 쓰던 `GET /api/sessions/:session/messages`는 `GET /api/chat` 복원으로 대체해 없앴다.

## 개발 규칙 (2026-09-14)

- 앱 개발 서버 인자는 `vp run dev --host 127.0.0.1 --port 5174`처럼 `--` 없이 넘긴다.
- 변형은 리터럴 태그를 가진 서로소 유니온으로 표현하고 `switch`로 분기한다. `"key" in obj` 식 판별은 쓰지 않는다. 라이브러리 유니온이 깔끔하게 구분되지 않으면 경계에서 한 번 우리 유니온으로 바꾼다.
