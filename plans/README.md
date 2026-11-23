# Implementation Plans

improve skill이 세 번에 걸쳐 만들었다. 실행하는 쪽은 계획을 끝까지 읽고 시작하고, STOP
conditions를 지키고, 끝나면 자기 행을 고친다.

- 2026-11-13, 범위는 성능: 001–003. 아래 "성능 감사" 절.
- 2026-11-14, 범위는 화면 사용성: 004–011. 아래 "화면 사용성 감사" 절.
- 2026-11-15, 범위는 칸반 보드 안쪽: 012–017. 아래 "칸반 보드 안쪽" 절.
- 2026-11-21, 범위는 기능 중복·겹침 정리: 024–027. 아래 "기능 중복 정리" 절.
- 2026-11-22, 범위는 기능 일관성 규칙(R1–R16) 구현: 028–. 아래 "일관성 규칙 구현" 절.

## 성능 감사 (2026-11-13)

측정 근거: 2026-11-13의 dev span 약 2.5시간치(span 539,047개). 그 백엔드는 commit `8451b4a1`
이전의 빌드다. 코드는 `f659bd09`–`4a803b10`에서 직접 읽었다. 003의 숫자는 같은 날 20:24(KST)에
다시 시작한 dev의 span에서 왔다.

카드 run 시간의 95.8%는 모델 호출이다. 아래 항목은 처리량이 아니라 반응성(첫 요청까지의 시간,
로드 직후의 요청 수, 유휴 부하)을 줄인다.

## Execution order & status

| Plan | Title                                                                                                                                                                   | Priority | Effort | Depends on                          | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001  | 첫 `ready`는 loader가 읽은 뒤로 바뀐 것이 없으면 다시 읽지 않는다                                                                                                       | P2       | M      | —                                   | DONE (검토 통과, 문서 1회 수정 뒤. merge 대기: 브랜치 `t3/first-ready-skip-refetch`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 002  | 변경을 알리는 MCP 서버의 도구 목록은 연결에 두고 다시 묻지 않는다                                                                                                       | P2       | M      | —                                   | DONE (검토 통과, 테스트 1회 수정 뒤. merge 대기: 브랜치 `t3/mcp-tool-list-kept-1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 003  | 백엔드는 listen을 시작하자마자 agent runtime을 만들기 시작한다                                                                                                          | P1       | S      | —                                   | DONE (검토 통과, merge 대기: 브랜치 `t3/backend-builds-runtime-at-start-1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 004  | 설정 창이 프로젝트를 스스로 고르고, 바뀐 값을 바로 보인다                                                                                                               | P1       | S–M    | 018                                 | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/settings-dialog-picks-project`, HEAD `73c70bf5`, 018 위에 commit 5개. typecheck에 `error TS`·경고 없음, `vp check`·`i18n:check`·문구 검사 통과, 새 jsdom 테스트 1개를 3번 돌려 모두 통과. 첫 실행이 멈춘 worktree가 남아 있다: 브랜치 `t3/settings-dialog-project-pick`, commit 없음, 고치다 만 변경 있음. 지워도 된다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 005  | 사이드바에서 프로젝트 고르기를 없애고, 프로젝트 헤더에 동작을 둔다                                                                                                      | P1       | L      | 004                                 | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/sidebar-project-header-actions`, HEAD `fd5f269c`, 004 위에 commit 3개. typecheck에 `error TS`·경고 없음, `vp check`·`i18n:check`·문구 검사 통과, jsdom 테스트 7개 통과. `sidebar.browser.tsx`는 13개 중 10개 통과. 남은 3개는 이 계획 전부터 실패하던 낡은 조회이고 006에서 고친다. 계획과 다른 곳: Step 2–6을 commit 하나로 냈다(중간 단계가 typecheck를 못 지남). `ProjectSection`을 쓰던 브라우저 테스트를 둘 지웠다. 보관 해제는 복원만 하고 그 프로젝트로 옮기지 않는다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 006  | 프로젝트 그룹 안을 한 목록으로 펴고, 최근 대화만 먼저 보인다                                                                                                            | P1       | M      | 005                                 | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/sidebar-flat-conversation-list`, HEAD `7ff1ef4b`, 005 위에 commit 3개. typecheck에 `error TS`·경고 없음, `vp check`·`i18n:check`·문구 검사 통과, jsdom 테스트 9개 통과, `sidebar.browser.tsx` 13개 모두 통과(낡은 조회 3개를 고쳤고 018의 `storedFolds` 단언도 처음으로 실행돼 통과했다). Step 1·2는 commit 하나다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 007  | 판단 대기는 모든 프로젝트의 것을 모아 보인다                                                                                                                            | P2       | M      | 005                                 | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/decision-inbox-across-projects`, HEAD `4c9841e7`, 006 위에 commit 4개. typecheck에 `error TS`·경고 없음, `vp check`·`i18n:check`·문구 검사 통과, navigation·settings jsdom 테스트 23개를 2번 돌려 모두 통과, 사이드바 브라우저 테스트 13개 통과(실행 에이전트 보고))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 008  | 대화가 자기 모델을 가진다 (저장, 실행, API)                                                                                                                             | P1       | L      | —                                   | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/conversation-keeps-model`, HEAD `4d17f9bc`, 007 위에 commit 6개. 두 typecheck에 오류·경고 없음, `vp check`·`memory-agent#i18n:check` 통과, 서버 테스트 22개와 jsdom 테스트 24개 통과. 검토에서 찾은 것 하나: 새 대화를 만들 때 `Effect.orDie(active.selected)`라서, 설정된 공급자가 등록에 없으면(`ProviderUnavailable`) 대화 만들기가 500으로 죽는다. 전에는 대화는 만들어지고 run에서 거절 문구가 나왔다. 내 계획이 그렇게 적었다. 009의 실행 지시 첫 단계로 고친다. 실제 run이 대화의 모델을 쓰는지는 테스트가 없다. 개발 서버를 다시 시작하면 migration이 `sessions.model_selection` 열을 더한다)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 009  | 채팅에 헤더를 두고, 입력창 아래줄에서 모델·추론·권한을 고른다                                                                                                           | P1       | L      | 008, 005                            | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/chat-header-composer-pickers`, HEAD `50499485`, 008 위에 commit 9개(첫 commit `350a115f`가 008의 검토 지적을 고친다). 두 typecheck에 오류·경고 없음, `vp check`·`i18n:check`·문구 검사 통과, jsdom 테스트 39개와 chat·navigation 브라우저 테스트 27개 통과. 새 선택기와 헤더를 누르는 자동 테스트는 없다(계획대로). 운영자가 화면에서 볼 것 6가지는 계획의 Done criteria에 있다. 남긴 것: `navigation/sidebar-disclosure-trigger.tsx`가 쓰는 곳 없는 파일이 됐다(아래 미계획 목록 7번). 다른 탭이 쥔 대화에서도 선택기가 눌리고 저장은 거절된다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 010  | 설정 메뉴를 다시 묶고, 테마·제보·프로젝트 개선의 자리를 옮긴다                                                                                                          | P2       | M      | 004, 005                            | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/settings-menu-regroup`, HEAD `5c807728`, 009 위에 commit 6개. 이 브랜치가 화면 사용성 줄의 끝이다(018·004–010을 담는다). typecheck에 `error TS`·경고 없음, `vp check`·`i18n:check`·문구 검사 통과, jsdom 테스트 46개와 chat·navigation 브라우저 테스트 27개 통과. 쓰는 곳 없던 `sidebar-disclosure-trigger.tsx`를 지웠다. 설정 창의 쪽 전환(`Tabs`를 값으로 제어)은 자동 테스트가 없어 운영자가 봐야 한다. 낡은 README 문장 넷이 남았다(`shared/README.md`의 `ThemeSelect`, `report/README.md`의 `ReportLink`, `entry/README.md`의 설정 쪽 목록, `navigation/README.md`의 `ProjectMenu` 줄). 016의 문서 단계에서 고친다)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 011  | 생성한 이미지를 대화에 남기는 설계를 정한다 (조사와 설계 문서)                                                                                                          | P3       | M      | —                                   | DONE (사용자가 2026-11-16에 방법 A를 골랐고 계획 022·023이 구현했다. 문서는 `main`에 있다. 2026-11-15 검토 통과. 브랜치 `t3/image-generation-conversation-design`, HEAD `07b90daa`, 파일 하나 `docs/designs/image-generation-in-conversation.md`. 핵심 근거 줄을 직접 대조했다. 문서 6절의 질문 5개에 사용자가 답하면 구현 계획을 쓴다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 012  | 프로젝트 보드가 멈춘 상태와 Goal 판단을 접지 않고 보인다                                                                                                                | P1       | M      | —                                   | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/project-board-stuck-states`, HEAD `de3aae30`, commit 6개. 브라우저 테스트 2개 통과, `vp check`·`i18n:check` 통과. `agent#typecheck`는 기준 commit의 오류 12개만 남고 새 오류는 없다. 018이 밑에 들어가면 통과한다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 013  | 카드 패널에서 바로 거절하고, 의존 카드를 골라 넣고, 드문 항목을 접는다                                                                                                  | P2       | M      | —                                   | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/card-panel-reject-editor`, HEAD `c2aff7c7`, 012 위에 commit 6개. 보드 브라우저 테스트 4개 통과, `vp check`·`i18n:check`·문구 검사 통과, typecheck는 기준 오류 12개만 남음. diff 전체 읽음)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 014  | Goal의 merge 결과를 보드 머리줄에 보이고 PR 주소를 링크로 둔다                                                                                                          | P2       | S–M    | 012                                 | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/goal-merge-result-on-board`, HEAD `37904184`. 012·013·018을 담고 그 위에 commit 4개. typecheck에 `error TS`·경고 없음, `vp check`·`i18n:check`·문구 검사 통과, 새 테스트 3개와 보드 브라우저 테스트 4개 통과. 계획과 다른 곳 하나: `t(mergeStateLabel(null))`이 lint 규칙을 죽여서 `schedule.merge`를 넘기게 썼다. 동작은 같다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 015  | 카드 패널을 보드를 덮는 Sheet가 아니라 보드 옆 칸으로 둔다                                                                                                              | P1       | M      | 013                                 | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/card-panel-beside-board`, HEAD `baa4aec5`, 014 위에 commit 1개. typecheck에 `error TS`·경고 없음, `vp check`·`i18n:check`·문구 검사 통과, 보드 브라우저 테스트 4개 통과. 계획과 다른 곳 둘: 단계마다가 아니라 commit 하나로 냈다. 보드의 카드를 누르면 열려 있던 새 카드 폼도 닫는다(쓰던 내용은 사라진다). 운영자가 화면에서 볼 것: 열 높이 스크롤, 가로 스크롤, 패널 안 스크롤, 끌 때 카드 모양, Esc)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 016  | 칸반 보드를 화면을 덮는 Sheet가 아니라 본문 영역에 둔다                                                                                                                 | P2       | L      | 015, 010                            | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/boards-in-main-area`, HEAD `510b0aed`. 이 브랜치 하나가 004–019를 모두 담는다(기준 commit 위에 commit 73개). 합칠 때 충돌은 `docs/decisions.md`뿐이었고 양쪽 항목 13개가 모두 남았다. 두 typecheck에 오류·경고 없음, `vp check`·두 `i18n:check`·문구 검사 통과, jsdom 테스트 106개, 브라우저 테스트 40개, 서버 테스트 59개 통과. `App`의 조립과 키보드로 카드 옮기기는 자동 테스트가 없다. 운영자가 화면에서 볼 것은 아래 "실행 결과")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 017  | 카드 패널이 카드 작업 폴더와 브랜치를 보인다 (서버 읽기 하나 포함)                                                                                                      | P2       | M      | 015                                 | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/card-panel-work-folder`, HEAD `0f571601`, 015 위에 commit 7개. 두 typecheck에 오류·경고 없음, `vp check`·`i18n:check`·문구 검사 통과, 서버 테스트 29개와 보드 브라우저 테스트 4개 통과. 이 브랜치가 보드 쪽 줄의 끝이다(012·013·014·015·017·018을 담는다). 서버가 바뀌어 개발 서버를 다시 시작해야 적용된다. 계획과 다른 곳: `cardBranchName`과 `useCardFolderQuery`를 `dual`로 썼다(Effect 진단 경고 때문))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 018  | `agent#typecheck`가 다시 통과하게 한다 (사이드바 테스트 두 파일). 004–017보다 먼저                                                                                      | P0       | S      | —                                   | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/agent-typecheck-baseline`, HEAD `63f48a8c`, commit 1개. `agent#typecheck`에 `error TS` 줄 없음, jsdom 테스트 4개 통과, `vp check` 통과, 단언 17개 그대로. `sidebar.browser.tsx`의 `storedFolds` 단언은 그 테스트가 더 앞에서 실패해 실행되지 않았다. 아래 "찾았고 아직 계획으로 만들지 않은 것" 8번)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 019  | 모델이 그린 SVG 그림이 첨부 정리에서 지워지지 않게 한다 (011의 조사가 찾은 버그. 서버만)                                                                                | P1       | S–M    | —                                   | DONE (2026-11-15 검토 통과, `main`에 있다(2026-11-22 확인: 같은 제목의 commit이 rebase되어 들어갔다). 브랜치 `t3/drawing-pictures-survive-cleanup`, HEAD `d5c82e2c`, 기준 commit 위에 commit 4개. `memory-agent#typecheck`에 오류·경고 없음, `vp check` 통과, 기록 테스트 9개 통과(새 테스트 2개 포함). diff 전체 읽음. 016이 합칠 때 함께 merge한다. 개발 서버를 다시 시작해야 적용된다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 020  | BTW 곁질문 기능을 없앤다 (화면, API 경로, 서버 서비스, 그 테스트. DB 표는 남긴다)                                                                                       | P2       | M      | 004–019                             | DONE (2026-11-16 검토 통과. 브랜치 `t3/remove-btw`, 끝 `30e40ffd`, commit 3개. 내가 다시 돌린 것: 두 typecheck 오류·경고 없음, `vp check`, 두 `i18n:check`, 문구 검사, 서버 테스트 57개, jsdom 116개, 브라우저 16개. 계획과 다른 점: `app-fetch`를 쓰는 테스트를 계획의 grep이 못 찾아 실행자가 `acp-bridge`와 `agent-chat-owner-process-recovery` 테스트를 골라 돌렸다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 021  | BTW의 DB 표를 지운다 (migration step 하나, 첨부 정리 조건, 테스트. 되돌릴 수 없는 삭제이고 사용자가 2026-11-16에 정했다)                                                | P2       | S      | 020                                 | DONE (2026-11-16 검토 통과. 브랜치 `t3/drop-btw-tables`, 끝 `d2023c2e`, commit 2개. 내가 다시 돌린 것: 두 typecheck 오류·경고 없음, `vp check`, 서버 테스트 63개(migration 테스트 전부 포함). 로컬 DB를 읽기 전용으로 보아 BTW 표를 가리키는 다른 표·trigger·view가 없음을 확인했다. 020과 함께 원격 `CreeJee/remove-btw`로 올리고 PR #45를 열었다(base는 #44의 브랜치))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 022  | 생성한 이미지를 대화에 적는다, 서버 (사용자가 2026-11-16에 방법 A를 골랐다. 새 경로 `POST /api/sessions/:session/images`, 점유 장부의 "쓰는 중" 표시, node와 메시지 셋) | P1       | M–L    | 019, 008, 021 뒤에 실행             | DONE (2026-11-16 검토 통과. 브랜치 `t3/image-generation-recorded-server`, 끝 `9c84a663`, commit 4개. 내가 다시 돌린 것: 두 typecheck 오류·경고 없음, `vp check`, 두 `i18n:check`, 서버 테스트 61개, jsdom 116개. 계획과 다른 점: 경로의 거절 목록에 `SelectedProviderUnavailable`을 더했다(옳다). 작은 지적 둘은 023의 Step 0으로 넘겼다: 기록을 한 transaction으로 묶기, `write`가 메시지 id를 돌려주게 하기. 자동 테스트가 없는 곳: run이 끝나기를 기다렸다가 적는 길, 저장 실패의 거절, 새 HTTP 경로)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 023  | 생성한 이미지를 대화에 적는다, 화면 (새 경로 쓰기, 응답 뒤 다시 읽기, 입력창 위 그림 없애기, 도구 카드의 그림, 옛 경로 지우기)                                          | P1       | M      | 022                                 | DONE (2026-11-16 검토 통과. 브랜치 `t3/image-generation-recorded-page`, 끝 `78ad4f66`, commit 5개. 내가 다시 돌린 것: 두 typecheck 오류·경고 없음, `vp check`, 두 `i18n:check`, 문구 검사, 서버 테스트 61개, jsdom 116개, 브라우저 40개. 새 경로는 `SessionsGroup`의 `SameSite`가 지킨다. 계획과 다른 점: `useImageGeneration`이 객체 하나를 받는다(Effect 진단 `TS377101` 때문), `apps/agent/README.md`에 줄 둘을 더했다. 022와 함께 원격 `CreeJee/image-generation-in-conversation`으로 올리고 PR #46을 열었다(base는 #45의 브랜치))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 024  | 대화의 세션 요약도 그 대화가 쓰는 모델로 만든다                                                                                                                         | P1       | S      | —                                   | DONE (2026-11-21 검토 통과, 2026-11-22 사용자 요청으로 merge(`27e06a42`), `main`도 같은 지점. 브랜치 `t3/summaries-use-conversation-model`, 끝 `5dc706cc`, commit 1개. 내가 다시 돌린 것: `memory-agent#typecheck` 오류·경고 없음, 서버 테스트 56개 통과(새 테스트 1개). diff 전체 읽음, 범위 안. 전역 선택이 없을 때의 단언은 지원 코드가 없어 만들지 않았다(계획대로))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 025  | 순위 병합(RRF)과 기억 단서 만들기를 한 곳에 둔다                                                                                                                        | P2       | S      | — (024와 같은 `chat.ts`, 다른 함수) | DONE (2026-11-21 검토 통과, 2026-11-22 사용자 요청으로 merge(`aef6355d`), `main`도 같은 지점. 브랜치 `t3/cf217538`, 끝 `cdf0e2be`, commit 3개. 내가 다시 돌린 것: `memory-agent#typecheck` 오류·경고 없음, 서버 테스트 45개 통과, `fusionK`는 `memory/rank-fusion.ts` 한 곳. diff 전체 읽음, 범위 안 9개 파일. 단서 문자열은 전과 같다. 024와 `chat.ts`를 함께 고치지만 다른 줄이다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 026  | 컨텍스트 표시가 실제로 줄이기 시작하는 지점을 기준으로 경고한다                                                                                                         | P2       | S–M    | —                                   | DONE (2026-11-21 검토 통과, 2026-11-22 사용자 요청으로 merge(`03c635a0`), `main`도 같은 지점. 브랜치 `t3/187174f3`, 끝 `8fe02da0`, commit 4개. 내가 다시 돌린 것: 두 typecheck 오류·경고 없음, 서버 테스트 54개, jsdom 34개, 브라우저 18개 통과, `compactAt` 남은 곳 없음(.ts·.tsx). diff 읽음. 달라진 동작 하나: 사용량이 모델 창보다 큰 옛 요청도 이제 경고 색이다. 화면과 서버 스키마가 함께 바뀌므로 개발 서버를 다시 시작해야 한다. 024와 `docs/decisions.md` 끝·`agent-chat.test.ts`에서 merge 충돌이 날 수 있다(양쪽 다 남긴다))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 027  | 칸반 검증자가 카드 에이전트와 같은 도구를 받고, 검사는 프로젝트 명령으로 돌린다 (사용자 결정 2026-11-21)                                                                | P1       | M      | —                                   | DONE (2026-11-21 검토 통과, 2026-11-22 사용자 요청으로 merge(`92e33b52`), `main`도 같은 지점. 브랜치 `t3/08acbd2a`, commit 6개(실행자 5 + 검토자 1). 내가 다시 돌린 것: 두 typecheck 오류·경고 없음, 서버 테스트 116개 통과. 검토에서 채운 것: `ChangedWork`를 `failureNote`에 넣어 카드의 다음 시도가 검증자가 고친 파일을 안다. 계획과 다른 점: `kanban-flow` 테스트 대신 `tests/kanban-skills.test.ts`에서 실제 `CardVerifier`로 시험했다(테스트 지원 코드가 `CardVerifier`를 통째로 바꾸기 때문). `save_code_skill`은 lazy 도구라 도구 목록 단언에서 뺐다. `git-worktrees.test.ts`의 5초 타임아웃은 병렬 부하에서 변경 전 코드에도 난다(024 worktree에서 3번 중 1번). 서버가 바뀌어 개발 서버를 다시 시작해야 적용된다)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 028  | 대화를 어느 탭에서든 조작한다 (서버는 다른 탭의 조작을 거절하지 않고, 화면은 읽기 전용이 되지 않는다)                                                                   | P1       | M      | —                                   | DONE (2026-11-22 검토 통과, 사용자 요청으로 merge(`72f599a8`), `main`도 같은 줄에 있다. 브랜치 `t3/plan-028-any-tab-session`, 끝 `e1504eed`, commit 4개(`c57605f8`, `ff215010`, `6f06ac43`, `e1504eed`), `5a4f3b96` 위. Step 1에서 한 번 멈췄다(같은 승인의 두 번째 답이 `no_user_turn`으로 거절되지 않았다). 사용자 결정: 이미 답한 승인은 다른 탭에서도 닫히고 늦은 답은 run 없이 버린다. 서버는 기다리지 않는 승인에 온 답을 `approval_not_pending`(409)으로 거절하고, 화면의 `answer`는 그 거절과 `run_in_progress`를 안내 없이 버리고 대화를 다시 읽는다. 내가 다시 돌린 것: 두 typecheck exit 0, 루트 `vp lint` exit 0, 서버 테스트 35파일 271개, 화면 jsdom·경계 테스트 8파일 44개, 브라우저 2파일 11개 통과. 계획과 다른 곳(받아들임): `Effect.map(Option.some)` 대신 `Effect.asSome`(lint 규칙), 계획에 없던 주석 둘(`newHolder`, `Send.holder`)을 고침, `apps/agent/README.md` 표는 포맷터가 폭을 다시 맞춰 64줄이 바뀜. 029로 넘긴 것: 화면에 남은 `session_in_use` 문구(`api.ts`, `message-queue.ts`, `use-image-generation.ts`))                                                                                                                                |
| 029  | 세션 lease와 `holder`를 코드에서 걷어낸다                                                                                                                               | P2       | M      | 028                                 | DONE (2026-11-23 `main`에 merge됨: `38671997`. merge한 tree에서 두 typecheck exit 0, 루트 `vp lint` exit 0, `tests/chat tests/golden tests/sessions tests/workflow` 24파일 216개 통과, 경계 테스트 3개 통과. 2026-11-22 검토 통과. 브랜치 `t3/remove-session-lease-holder`, 끝 `2989306f`, commit 5개(`babfd567`, `8d0bb0ed`, `916a1544`, `97edc1bc`, 내 검토 수정 `2989306f`), `1258c1c8` 위. 102파일, 410줄 더하고 1204줄 지움. 내가 다시 돌린 것: 두 typecheck exit 0, 루트 `vp lint` exit 0, 서버 테스트 42파일 중 41파일 통과(329개 중 328개), 화면 jsdom·경계 테스트 8파일 44개, 브라우저 2파일 11개 통과. 실패한 하나는 029가 건드리지 않은 `tests/workflow/provider-retry.test.ts`의 "restores a pending wait after the layer is rebuilt without recomputing it"다. 혼자 세 번, `tests/workflow` 폴더로 한 번 돌리면 통과한다. 여러 파일과 함께 돌 때 가끔 실패하는 테스트로 보이고, 원인은 아직 보지 않았다(남은 일). 계획과 다른 곳(받아들임): `events/context.ts`의 `"session_lease"` literal 삭제, `eval/*.ts` 네 파일의 `holder` 인자 삭제, 하나만 남은 `error` 배열을 벗김, `docs/httpapi-migration.md`와 `docs/app-state-streams.md`의 지난 기록은 그대로 둠) |
| 030  | 세션 inbox 표를 만들고, 다른 대화가 남긴 메시지를 거기에 둔다                                                                                                           | P1       | M      | —                                   | DONE (2026-11-22 검토 통과, 사용자 요청으로 merge(`7ad69744`), `main`도 같은 줄에 있다. 브랜치 `t3/session-inbox-table-blocked`, 끝 `3c2db3ce`, commit 4개. 내가 다시 돌린 것: 두 typecheck 오류 없음, 루트 `vp lint` 통과, 서버 테스트 58개 통과(새 `inbox.test.ts` 7개, migration 테스트 3개 포함). diff 전체 읽음. 옛 표의 CHECK 둘이 새 표와 같아 옛 행은 그대로 옮겨진다. `main`과 미리 병합해 보니 충돌 없음. 계획과 다른 점: `InboxEntry`는 Schema가 아니라 `inboxPayloads`에서 만든 타입이다. delivered로 바꿀 때 claim 열도 비운다. 뒤 계획이 볼 것: `SessionDispatches.consume`이 `inbox.claim`을 그대로 불러, 보낸 쪽이 둘이 되면 다른 보낸 쪽의 행까지 잡는다. 그때 `claim`에 보낸 쪽 조건을 넣는다)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 031  | 처음 Plan의 승인자를 프로젝트 권한 모드가 정한다 (정렬 질문은 언제나 먼저 하고, 입력창의 Plan 모드를 없앤다)                                                            | P1       | M      | —                                   | DONE. 병합 `2a444e18` (브랜치 `t3/first-plan-approver-permission-mode`, `370ead14`). 실제 모델로 정렬 질문과 승인 버튼을 보는 확인은 아직 하지 않았다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 032  | 저장된 Goal/Plan 모드 값을 지운다 (`WorkflowMode`, move `"plan"`, `WorkflowState.mode`, DB 열 `mode`)                                                                   | P2       | M      | 031                                 | DONE (2026-11-22 검토 통과, 사용자 요청으로 merge(`a2de0f4e`), `main`도 같은 줄에 있다. 브랜치 `t3/remove-stored-workflow-mode`, 끝 `879299c1`, commit 4개(실행자 3 + 검토자 1: 낡은 테스트 이름 하나). 내가 다시 돌린 것: 두 typecheck 오류 없음, 루트 `vp lint` 통과, 서버 테스트 전체 257파일 1367개 통과(`--maxWorkers=4`), 화면 테스트 43개, 브라우저 테스트 6개 통과. diff 전체 읽음. golden 3개는 한 줄씩 삭제, `docs/goal-transitions.md`는 상태 수 9줄만 절반이 됨. ledger 글자(`shaping -> running`)를 해석하는 코드는 없다. 계획의 완료 기준 `rg`는 `placeText`에 `\b`가 없어 상관없는 `replaceTextFileEffect`에 걸렸다. `\bplaceText\b`로는 출력이 없다. `main`과 미리 병합하면 충돌 없음. 030과는 `migrations.ts` 끝과 `docs/decisions.md` 끝에서 충돌하고 둘 다 남긴다). 동작은 바뀌지 않는다. DB 열을 지우는 migration이 하나 있어 029·030과 `migrations` 배열 끝에서 충돌할 수 있다(먼저 병합된 것을 앞에 둔다)                                                                                                                                                                                                                                              |
| 033  | 끝난 백그라운드 작업의 알림을 세션 inbox에 둔다 (`background_tasks.delivered_*` 열을 지우고 inbox가 보낸 쪽을 가려 잡는다)                                              | P1       | M      | 030, 035                            | TODO (035가 merge됐다(`21354a53`). 계획 글은 아직 옛 이름(`session_inbox`, `SessionInbox`)으로 쓰여 있어 실행 전에 새 이름으로 고쳐 다시 찍어야 한다. 알림 넷이 따를 규칙 하나를 사용자가 정하면 그것도 함께 넣는다. 2026-11-23 계획 씀, `3547b7e6`에서. 독립 검토 한 번 거쳐 고침)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 034  | 도구 승인의 답은 승인과 거절 둘이다 (`editedArgs`를 서버에서 지운다)                                                                                                    | P2       | S      | —                                   | DONE (2026-11-23 검토 통과, 사용자 요청으로 merge(`3a0841d5`). 브랜치 `t3/approvals-approve-or-decline`, 끝 `d366582e`, commit 2개. 내가 다시 돌린 것: 두 typecheck 오류 없음, 루트 `vp lint` 통과, `tests/loop tests/golden tests/chat tests/permission src/loop` 16파일 118개 통과. golden 다섯 파일은 삭제만 534줄이다. 독립 검토 없이 실행했다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 035  | 세션 inbox의 이름을 orchestrator notifications로 바꾼다 (표·서비스·타입. 보낸 쪽에서 `user`를 빼고, 전달 값의 타입 `MessageDelivery`를 따로 둔다)                       | P1       | S      | 030                                 | DONE (2026-11-23 검토 통과, 사용자 요청으로 merge(`21354a53`). 브랜치 `t3/orchestrator-notifications-rename`, 끝 `7af04c9b`, commit 4개(실행자 3 + 검토자 1: 테스트의 run id에서 옛 낱말을 뺌). 내가 다시 돌린 것: 두 typecheck 오류 없음, 루트 `vp lint` 통과, 계획의 테스트 23파일 136개 통과. merge 뒤 `main`에서 034와 합쳐 37파일 231개 통과. 독립 검토 없이 실행했다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (한 줄 이유) | REJECTED (한 줄 이유)

## 실행 방식 (2026-11-15, 004–017)

사용자가 004–017을 모두 실행하라고 했다. 계획마다 실행 에이전트 하나가 자기 worktree에서 고치고
commit한다. 조언자(improve)는 diff를 검토하고 이 표를 고친다. main에 merge하거나 push하지 않는다.

- worktree는 늘 main의 commit(`d65cc285`)에서 만들어진다. 앞선 계획 위에 서야 하는 계획은 시작할
  때 앞선 계획의 브랜치로 fast-forward한다.
- 기준 commit에서 `vp run agent#typecheck`가 오류 12개로 실패한다(테스트 두 파일). 계획을 쓸 때 이
  검사를 돌려 보지 않아 놓쳤다. 018이 먼저 고치고, 두 줄 모두 018의 브랜치 위에서 시작한다.
  `memory-agent#typecheck`와 `vp check`는 기준 commit에서 통과한다.
- 줄 A: 018 → 004 → 005 → 006 → 007 → 008 → 009 → 010. 줄 B: 018 → 012 → 013 → 014 → 015 → 017.
  012와 013은 018을 기다리지 않고 기준 commit 위에서 먼저 했다. 018이 고치는 두 파일은 줄 B가 건드리지 않는다.
  그동안 줄 B의 typecheck 기준은 "그 두 파일 밖에 `error TS` 줄이 없다"이다. 018은 014를 시작할 때 merge한다.
  011은 혼자다.
- 016은 줄 A의 끝에서 시작해 줄 B의 끝과 011을 merge한 뒤에 한다. `ko.po`의 충돌은 한쪽을 고른 뒤
  `vp run agent#i18n:extract`로 다시 만들고, `docs/decisions.md`의 충돌은 양쪽 항목을 모두 남긴다.
- 끝나면 016의 브랜치 하나에 004–017이 모두 들어 있다. merge는 사용자가 정한다.

### main에 merge (2026-11-16)

사용자가 "main 머지"를 요청했다. PR 셋을 차례로 merge commit으로 `main`에 넣었다.

- #44 → `d65e2ce8`, #45 → `c40aae1e`(base를 `main`으로 바꾼 뒤), #46 → `82d5cd4d`(base를 `main`으로 바꾼 뒤).
- 원격 `main`은 `82d5cd4d`다. 그 파일 내용은 내가 검토한 끝 commit `78ad4f66`과 똑같다(`git diff --stat` 출력 없음).
- 사용자의 로컬 `main`은 건드리지 않았다(`2b70376e`, 원격보다 commit 90개 뒤). `git pull --ff-only`는 사용자가 한다.
- 사용자의 요청으로 2026-11-16에 정리했다. 원격 브랜치 `CreeJee/ui-usability-rework`, `CreeJee/remove-btw`, `CreeJee/image-generation-in-conversation`을 지웠다. 이 작업의 로컬 브랜치 22개(`t3/…`)와 그 worktree를 지웠다. 버린 `t3/settings-dialog-project-pick`의 commit하지 않은 수정 3개 파일도 함께 지웠다(004가 대신했다). 다른 세션의 `t3/*` 브랜치와 worktree는 건드리지 않았다. 이 문서의 worktree 경로와 브랜치 이름은 이제 없다. commit id는 `main`의 기록에 남아 있다.
- 받은 뒤 개발 서버를 다시 시작하면 migration 둘이 돈다: `sessions.model_selection` 열을 더하고, BTW 표 셋을 지운다(저장된 BTW 스레드는 되살릴 수 없다).

### 새 main 위로 옮김과 PR (2026-11-16)

- 2026-11-16에 `main`이 rebase되어 `d65cc285`에서 `2b70376e`로 바뀌었다. 두 commit의 파일 차이는
  `docs/decisions.md`뿐이다(몇 항목이 파일 끝으로 옮겨졌다).
- 실행자가 `d65cc285..510b0aed`를 `git rebase --rebase-merges --onto 2b70376e d65cc285`로 다시 쌓았다.
  결과는 `t3/rebase-boards-onto-new-main`(끝 `7696fc99`, commit 73개)이다. 충돌은 5번, 모두
  `docs/decisions.md`였고 양쪽 줄을 모두 남겼다.
- 내가 확인한 것: `510b0aed`와의 차이가 `docs/decisions.md` 한 파일뿐이다. 새 main의 줄이 하나도
  지워지지 않았다. 더해진 줄이 옮기기 전과 똑같다. `vp check` 통과(새 worktree에서
  `pnpm install --frozen-lockfile`과 `react-router typegen`을 한 뒤).
- 사용자의 요청으로 원격에 `CreeJee/ui-usability-rework`로 올리고 PR을 열었다:
  https://github.com/CreeJee/context-generactive-ai-agent/pull/44 (base `main`, commit 73개, 파일 91개).
  SSH push가 거절되어 `gh` 인증의 HTTPS로 올렸다. `main`에는 push하지 않았다.
- 아래 "실행 결과 (2026-11-15)"의 "받을 브랜치"는 이제 `t3/rebase-boards-onto-new-main`이다.
  `t3/boards-in-main-area`는 옛 main 위의 것이라 더 쓰지 않는다.

### 실행 결과 (2026-11-15)

004–019를 모두 실행했고 검토를 통과했다. main에는 아무것도 merge하지 않았다.

- **받을 브랜치는 하나다**: `t3/boards-in-main-area`(HEAD `510b0aed`). 기준 commit `d65cc285` 위에
  commit 73개이고 004–019를 모두 담는다. worktree는
  `/Users/creejee/.t3/worktrees/context-generactive-agent/t3-b0fcf408-f17d88ec88782b71`이다.
- 그 브랜치에서 내가 다시 돌린 것: `vp run agent#typecheck`와 `vp run memory-agent#typecheck`(오류와
  경고 없음), `vp check`, `vp run agent#i18n:check`, `vp run memory-agent#i18n:check`,
  문구 내용 검사, `apps/agent`의 jsdom 테스트 106개, 브라우저 테스트 40개, 서버의 해당 테스트 59개.
  서버 전체 테스트는 돌리지 않았다.
- 계획마다의 브랜치는 위 표에 있다. 줄 A의 끝은 `t3/settings-menu-regroup`, 줄 B의 끝은
  `t3/card-panel-work-folder`이고, 019는 `t3/drawing-pictures-survive-cleanup`, 011은
  `t3/image-generation-conversation-design`이다. 모두 최종 브랜치에 들어 있다.
- 서버가 바뀌었다(008, 017, 019). 개발 서버를 다시 시작해야 적용된다. 다시 시작하면 migration이
  `sessions.model_selection` 열을 더한다.
- 실행하다 찾아 함께 고친 것: 기준 commit의 typecheck 오류 12개(018), 기준 commit부터 실패하던
  사이드바 브라우저 테스트 6개(005·006), draw skill의 그림이 앱을 다시 시작하면 지워지던 것(019),
  008에서 공급자를 못 찾으면 새 대화 만들기가 죽던 것(009의 첫 commit), 쓰는 곳 없는 파일과 낡은
  README 문장(010·016).
- 자동 테스트가 없어 화면에서 봐야 하는 것:
  1. 보드: 프로젝트 보드를 연 채 사이드바에서 다른 대화를 누르면 보드가 닫히고 그 대화가 열린다.
     보드를 닫으면 쓰던 글과 스크롤 위치가 그대로다. 사이드바를 접었을 때 펼치기 버튼이 보드
     제목을 가리지 않는다. 손잡이에서 Space로 카드를 집고 화살표를 한 번 누르면 한 칸만 움직인다.
     보드를 연 채 Work Trace 패널이 열린다(016).
  2. 카드 패널: 열 높이 스크롤, 가로 스크롤, 패널 안 스크롤, 끌 때 카드 모양, Esc(015).
  3. 대화의 모델: 대화 A와 B의 모델이 따로 저장된다. 새 대화는 계정 관리 창의 "새 대화의 기본
     모델"로 시작한다. 실제 run이 그 대화의 모델을 쓴다(008·009. run 쪽은 테스트가 없다).
  4. 설정 창: 쪽을 바꿀 때 내용이 따라 바뀐다. 프로젝트 고르기 줄은 프로젝트 쪽에서만 보인다(010).
- 계획과 다르게 들어간 동작:
  - 보드의 카드를 누르면 열려 있던 새 카드 폼이 닫히고 쓰던 내용이 사라진다(015).
  - 보관된 프로젝트를 해제해도 그 프로젝트로 옮겨 가지 않는다(005).
  - 다른 탭이 쥔 대화에서도 모델 선택기와 세션 보드 버튼이 눌린다. 서버가 거절하고 문구가 나온다
    (009·016).
- 남은 worktree: 실행 에이전트의 worktree 18개가 `~/.t3/worktrees/context-generactive-agent/`에
  있다. `t3/settings-dialog-project-pick`(004의 첫 실행)은 commit 없이 고치다 만 변경만 있다. 최종
  브랜치를 받은 뒤에는 모두 지워도 된다.
- 사용자의 답을 기다리는 것: 이미지 생성의 방법(011 문서 6절의 질문 5개), BTW를 남길지.

## Dependency notes

### 004–011 (화면 사용성)

- 권하는 순서: 004 → 005 → 006 → 007 → 008 → 009 → 010 → 011.
- 008은 서버만 바꾸고 004–007과 닿지 않는다. 먼저 하거나 나란히 해도 된다. 다만 같은 checkout을
  쓰므로 한 번에 한 계획만 실행한다.
- 005, 009, 010은 모두 `apps/agent/app/entry/index.tsx`를 고친다. 순서를 바꾸면 각 계획의 발췌가
  실제 코드와 달라져 Drift check에서 멈춘다. 번호 순서를 지킨다.
- 006과 007은 서로 닿지 않는다. 둘 다 005가 바꾼 `navigation/sidebar.tsx`와 `index.tsx` 위에 선다.
- 011은 코드를 고치지 않는다. 언제 해도 된다. 008 뒤에 하면 대화의 모델을 설계에 반영할 수 있다.
- 008은 migration 하나를 더하고 백엔드를 바꾼다. 반영하려면 dev를 다시 시작해야 한다. 004–007,
  009, 010은 화면 코드라 dev가 바로 반영한다.

### 012–017 (칸반 보드 안쪽)

- 권하는 순서: 012 → 013 → 014 → 015 → 016 → 017. 여섯 계획이 같은 파일들
  (`chat/board/project-board.tsx`, `chat/board/card-peek.tsx`, `chat/board/board-surface.tsx`,
  `chat/board-panel.tsx`)을 차례로 고친다. 뒤의 계획은 앞의 계획이 바꾼 모양을 "앞선 계획이 바꾼
  것"으로 적어 두었다. 순서를 바꾸면 Drift check에서 멈춘다.
- 012–015와 017은 004–011과 닿는 파일이 없다. 004–011보다 먼저 해도 된다.
- 016만 `apps/agent/app/entry/index.tsx`와 `chat/chat-panel.tsx`를 고친다. 005·009·010이 모두 끝난
  뒤에 한다. 먼저 하면 그 계획들의 발췌가 실제 코드와 달라진다.
- 017은 016을 기다리지 않는다. 015 뒤면 된다. 017은 백엔드를 바꾸므로 반영하려면 dev를 다시
  시작해야 한다. 012–016은 화면 코드라 dev가 바로 반영한다.
- 015와 016은 화면을 띄워 보지 않고 썼다. 각 계획의 "Maintenance notes"에 운영자가 dev에서 볼
  목록이 있다. 015를 한 뒤 그 목록을 보고 나서 016으로 가기를 권한다.

### 001–003 (성능)

- 세 계획은 서로 닿지 않는다. dev 직후의 첫 화면이 느린 것은 003이 다루므로 003을 먼저 한다.
- 001은 로드 직후의 요청 수를 줄일 뿐, 첫 화면이 그려지기까지의 시간은 줄이지 않는다.
- 셋 다 백엔드 코드를 바꾼다. dev 백엔드는 dev 시작 때 한 번만 빌드되므로 반영하려면 dev를
  다시 시작해야 한다.

## 성능 감사에서 찾았고 아직 계획으로 만들지 않은 것

선택을 기다린다. 숫자는 위 span에서 왔다.

1. 세션 lease 갱신(20초)마다 `run-state`를 발행한다 — 유휴 탭이 20초마다 GET 5–7개(코드 추정). `apps/agent/app/.server/api/sessions.ts:287`
2. `run_skill` 한 번에 skill 전체 목록을 두 번 읽는다 — 중복 123회, 8.9초. `packages/memory-agent/src/tools/code.ts:266`, `tools/approved.ts:124`
3. import pass가 5분마다 프로젝트 78개의 node를 모두 센다 — pass당 6–20초(import worker). `packages/memory-agent/src/imports/pass.ts:296`
4. 카드 큐 taker가 일이 없어도 5초마다 문장 3개를 돌린다. `packages/memory-agent/src/kanban/persisted-queue-store.ts:200`
5. 보드를 볼 때마다 활성 Goal 전부의 상태를 다시 읽는다 — look당 문장 약 58개. `packages/memory-agent/src/kanban/scheduler.ts:152`
6. run마다 프로젝트 전체 폴더를 훑어 AGENTS.md를 찾는다 — 첫 요청 p50 168 ms, p95 1.9초. `packages/memory-agent/src/agent/project-instructions.ts:28`
7. 모델 요청마다 세션의 tool 결과 전부를 읽는다 — 긴 대화에서 p50 20 ms, 최대 1초. `packages/memory-agent/src/memory/nodes.ts:432`
8. run log 읽기가 페이지마다 `BEGIN IMMEDIATE`를 연다 — 16,554페이지. `packages/memory-agent/src/workflow/durable-stream.ts:165`
9. git 실행 파일을 호출마다 PATH에서 다시 찾는다 — `Host.fileExists` 12,703회. `packages/memory-agent/src/runtime/host.ts:54`
10. `ChatPanel`이 대화 상태 전체를 구독한다. `apps/agent/app/entry/chat/use-agent-chat.ts:69`
11. (계획 003이 됐다) 첫 `/api` 요청이 runtime 전체 구성을 기다린다 — 표본 2회 5.4초, 5.6초. `apps/agent/app/.server/agent.ts:59`
12. Work Trace 이벤트마다 트리 전체를 다시 읽는다. `apps/agent/app/entry/session/work-trace.ts:79`
13. dev 시작마다 쓰이지 않는 memory-agent 번들을 만든다. `apps/agent/package.json:9`
14. 루트 `typecheck`가 같은 tsc 프로젝트를 두 번 검사한다. `package.json:12`
15. `docs/app-state-streams.md`가 코드와 다르다("50 ms 묶음", "유휴 세션은 주기 GET 없음").

측정 기반: SQL span이 연결 대기를 포함한다. 4, 5, 8번의 전후를 견주려면 Effect의
`SpanPropagationEnabled`로 대기 시간을 따로 남기는 일이 먼저다.

## 성능 감사: Findings considered and rejected

- sandbox worker 재사용: 실행마다 worker 하나는 allowlist 격리를 위한 설계다 (`docs/shell-skill-sandbox.md:93`).
- skill 카탈로그 캐시: 2026-11-09에 두지 않기로 했다 (`docs/decisions.md:4516`).
- MCP 설정 파일 감시: `configured`가 이미 run마다 두 파일을 읽고 바뀐 연결을 닫는다 (`packages/memory-agent/src/mcp/servers.ts:495`).
- 대화 목록 가상화, `content-visibility`: 이전에 검토하고 버렸다.
- `CardWorktrees.settle`의 27–52초: `e9345b08`에서 고쳤다.
- migration 110의 61초와 그 직후의 `incremental_vacuum` 763회: 업그레이드당 한 번이다.
- 메모리 검색·임베딩·rerank: 재설계 중이라 보지 않았다.

## 화면 사용성 감사 (2026-11-14)

요청: 화면 전체의 사용성을 T3 Code와 비슷하게 다시 정리한다. 프로젝트 고르기가 뜻이 없어
보이고, 뜻 없는 기능을 정리한다. 코드는 commit `d65cc285`에서 읽었다.

근거로 쓴 로컬 DB의 수(2026-11-14, 읽기 전용): 프로젝트 78개(숨김 59, 목록 19), 대화 800개(보관
238), 가장 큰 프로젝트의 보관하지 않은 대화 230개, 외부 에이전트 대화 4개, BTW 스레드 2개, 제보
대화 2개, 칸반 Goal 7개와 카드 75개.

### 사용자가 정한 것

- 모델은 대화마다 둔다(008, 009).
- 사이드바 헤더의 제보 아이콘을 뺀다. `/report` 명령과 설정의 링크는 남긴다(010).
- 프로젝트 개선을 설정에서 빼 프로젝트 `…` 메뉴로 옮긴다(010).
- 이미지 생성은 없애지 않고 제대로 만든다(011이 설계를 정한다).
- BTW는 정하지 않았다(다른 대화에서 묻는 것과 비슷해 보여 고민 중). 그래서 기능은 그대로 두고
  009가 버튼의 자리만 채팅 헤더로 옮긴다.

### 계획을 쓰며 내가 고른 기본값

사용자가 따로 정하지 않은 것이다. 바꾸려면 해당 계획을 고친 뒤 실행한다.

- URL의 `project` 값은 "열린 대화의 프로젝트"라는 뜻으로 남긴다(005).
- 외부 에이전트 대화는 `/agent` 명령으로만 만든다. 사이드바의 드롭다운은 없앤다(005).
- 칸반 보드의 카드 수는 프로젝트 `…` 메뉴의 항목에 붙인다(005).
- 프로젝트 그룹은 대화 8개를 먼저 보이고 나머지는 "N개 더 보기"로 편다. 답변 중인 대화와 열린
  대화는 늘 보인다(006).
- 대화의 모델이 비어 있으면 앱의 기본값을 따른다. 화면에서 만든 대화는 만들 때의 기본값을 적어
  둔다. 입력창에서 고르면 그 대화에만 적는다(008, 009).
- 앱의 기본 모델은 계정 관리 Sheet의 "새 대화의 기본 모델"에서 바꾼다(009).
- 구독 계정 고르기는 지금처럼 공급자마다 하나다(008).
- 설정 메뉴는 일반 / 도구 / 기억 / 프로젝트 / 실행으로 묶고, 처음 쪽은 "일반"이다(010).

### 찾았고 아직 계획으로 만들지 않은 것

1. 입력창 둘레에 층이 많다(대기열, 알림, 하위 에이전트, 백그라운드 작업, 이미지 결과, 첨부 등이
   입력창 위에 쌓인다). `apps/agent/app/entry/chat/chat-panel.tsx`, `chat/chat-composer.tsx`.
   009가 헤더와 아래줄을 정리한 뒤에 다시 본다.
2. 하위 에이전트가 서너 곳에 보이고 라벨이 서로 다르다. 한 곳으로 모을지 정해야 한다.
3. slash 명령에 같은 일을 하는 것이 겹치고 `/mode`의 이름이 하는 일과 다르다.
   `apps/agent/app/entry/chat/slash-commands.ts`. 009가 `/model`, `/effort`의 뜻을 바꾸므로 그 뒤에 본다.
4. 채팅 단계에서 세션 보드로 가는 길이 없어 보인다(확신 중간. 확인이 더 필요하다).
5. BTW를 남길지 없앨지. 사용자의 결정을 기다린다.
6. 설정 쪽의 남은 정리: 임베딩 쪽의 진단 표시, 이미지 생성 쪽의 키 유무 표시(011의 "곁가지 3"이
   다룬다), "긴 대화"와 "기억 범위"를 한 쪽으로 합치기.
7. 005–010이 지운 뒤에 남는 쓰이지 않는 코드와 문구의 정리.
8. `apps/agent/app/entry/navigation/sidebar.browser.tsx`의 테스트 6개가 기준 commit `d65cc285`에서
   이미 실패한다(2026-11-15, 018 검토 때 직접 돌려 확인. 16개 중 10개 통과). 실패하는 테스트는
   551, 608, 675, 711, 745, 825행에서 시작한다. 모두 프로젝트 그룹 헤더를
   `getByRole("button", { name: "Alpha" })`처럼 이름 전체로 찾는다. 헤더 버튼의 이름에는 접힌
   그룹의 "대화 N개"와 고른 프로젝트의 "사용 중"이 붙으므로 맞지 않는다. 같은 테스트 안에서
   `/^Alpha/`로 찾는 줄은 통과한다. 005가 이 파일을 고치므로 005에서 함께 고친다(005의 실행
   지시에 넣었다). 005 뒤에도 남으면 따로 계획을 쓴다.
9. 011의 조사가 찾은 것 둘(2026-11-15, 근거 줄은 내가 다시 읽어 확인했다).
   - 생성한 이미지는 어디에도 묶이지 않은 첨부로 저장된다. 앱을 다시 시작하면 지워진다.
     `packages/memory-agent/src/attachments/attachments.ts:143-152`(묶이지 않은 첨부를 지우는 조건,
     만든 시각을 보지 않는다), `packages/memory-agent/src/agent/chat.ts:665`(시작 때 정리).
     011의 구현 계획이 고친다.
   - 같은 원인으로 `draw` skill이 그린 SVG 그림도 지워지는 것으로 보인다.
     `packages/memory-agent/src/attachments/previews.ts:43`이 `saveDrawing`만 부르고, 첨부를 묶는
     `link`는 사용자 턴을 기록하는 세 곳만 부른다(`agent/chat.ts:1472`, `queue/delivery.ts:63`,
     `btw/chat.ts:185`). 이것은 011의 선택과 상관없는 버그다. 계획 019로 쓴다.
10. 계획들이 적은 문구 내용 검사 명령 `node lint/wording/check/main.ts check`는 파일 인자가 없으면
    "Missing required argument: file"로 끝난다. commit 훅은 staged `.po`를 인자로 준다
    (`vite.config.ts:32`). 아직 실행하지 않은 계획(005–010, 014–017)의 명령에
    `apps/agent/app/locales/ko.po`를 붙였다.

### Findings considered and rejected

- 대기 중인 메시지를 고치다 Esc를 누르면 그 메시지가 없어진다: `apps/agent/README.md`가 적어 둔
  동작이다("Esc는 그 메시지 제거").
- 사이드바의 "다른 프로젝트 기억" 스위치가 듣지 않는다: 전체 설정 `crossProjectRecall`이 꺼져
  있을 때만 그렇고, 그것은 설계다. 005가 스위치를 프로젝트 `…` 메뉴로 옮긴다.
- 사이드바가 프로젝트를 모두 보이는 것: 2026-11-12의 결정이다. 문제는 그 위에 남은 "고른
  프로젝트" UI였고 005가 그것을 없앤다.

### 칸반 보드 안쪽 (2026-11-14 감사, 2026-11-15 계획 012–017)

찾은 것과 계획의 짝: 1번 → 015·016, 2번·3번·9번 → 012, 4번 → 014, 5번·6번 → 013, 7번 → 013(실패
횟수 표시)과 017(작업 폴더), 8번 → 016이 절반을 푼다(보드가 다른 패널을 가리지 않는다). 나머지
절반은 아래 "아직 계획으로 만들지 않은 것"에 있다.

사용자가 정한 것(2026-11-15):

- 보드는 화면을 덮는 Sheet가 아니라 본문 영역의 보기로 둔다(016). 카드 패널은 보드 옆 칸으로
  둔다(015). "칸반 보드 화면 (2026-10-18)"의 두 Sheet를 바꾼다.
- 카드 작업 폴더의 경로와 브랜치는 판단 내용에 넣지 않고, 카드 패널이 따로 읽는 항목으로
  보인다(017).

계획을 쓰며 내가 고른 기본값:

- 프로젝트 보드의 상태 패널은 사람을 기다리는 대화가 있을 때만 펼친 채로 연다. 일시 중지한 Goal도
  "기다리는 대화"로 센다(012).
- 의존 카드는 검색되는 고르기가 아니라 토글 목록으로 고른다. Plan 하나의 카드가 2–21장이다(013).
- 보드가 열린 동안 대화 화면은 언마운트하지 않고 숨긴다. 대화의 lease와 실행이 이어진다(016).
- Esc는 카드 패널만 닫는다. 본문 영역의 보드는 "보드 닫기"나 뒤로 가기로 닫는다(016).
- 세션 보드는 `disabled`를 받지 않는다. 다른 창이 그 대화를 쓰고 있으면 서버가 거절하고 알림이
  뜬다. 프로젝트 보드가 이미 그렇게 한다(016).
- 작업 폴더는 보드 전체 읽기에 넣지 않고 카드 하나를 따로 읽는 endpoint로 둔다. 보드를 읽을
  때마다 카드 수만큼 git이 도는 것을 피한다(017).

아직 계획으로 만들지 않은 것:

- 진행 중인 카드가 지금 무엇을 하는지 보드에서 보기. 카드와 Work Trace 작업을 잇는 값을 서버가
  주어야 한다(`kanban_card_runs.trace_attempt_id`가 있다). 017과 같은 방식(카드 하나를 따로 읽기)이
  맞아 보인다. 016과 017이 들어간 뒤에 다시 본다.
- 칸반이 끝난 뒤의 merge 결과 표시. `/kanban`이 `{ active: false }`를 줄 때는 014의 배지가 나오지
  않는다. merge된 Goal의 보드가 언제 비활성이 되는지는 읽지 않았다.
- 완료 열을 처음에 접거나 최근 몇 장만 보이기(완료가 카드의 71%다).
- "내 차례" 필터: 판단, 승인, 확인이 필요한 카드만 보이기.

읽은 것: `apps/agent/app/entry/chat/board/*`, `chat/board-panel.tsx`, `chat/workflow-panel.tsx`,
`chat/decision-prompt.tsx`, 서버 계약 `packages/memory-agent/src/kanban/contracts.ts`,
`workflow/contracts.ts`. 로컬 DB의 수(읽기 전용): 지금 Plan의 카드 161장 가운데 완료 114장,
Plan 하나에 카드 2–21장, 보드 변경 저장 가운데 사용자 59건·오케스트레이터 936건, 판단 요청 49건
(RetryExhausted 32, MergeConflict 9, UncertainSideEffect 5, IntegrationConflict 2,
ProtectedBranchMerge 1), 카드 161장 가운데 위험 2장·경계 0·필요한 근거 0·사람 판단 0.

1. 카드 패널이 보드를 가린다. 카드 패널은 보드 Sheet 위에 뜨는 두 번째 Sheet이고, 그 배경은
   검정 80%에 흐림이다(`components/ui/sheet.tsx:29`, `board/card-peek.tsx:432-439`). 카드를 연 동안
   보드가 보이지 않고, 다른 카드를 보려면 닫고 다시 눌러야 하며, j/k 이동이 듣지 않는다. 카드 패널을
   Sheet로 둔 것은 2026-10-18의 결정이다(`docs/decisions.md:994`). 사용자가 2026-11-15에 바꾸기로 했다.
2. 프로젝트 보드가 멈춘 상태를 숨긴다. 보드 루프 멈춤과 다시 시작, 자동 Plan 작성 멈춤, 일시 중지,
   변경 요청 대기, 카드 추가, 칸반으로 전환이 모두 처음에 접혀 있는 "대화 순서와 상태" 안에 있다
   (`board/project-board.tsx:197-295`). 머리줄에는 수 넷만 있다. 확인이 필요한 카드 수
   (`ReplanWaitBadge`)는 프로젝트 보드에 아예 없다.
3. Goal 수준의 판단을 프로젝트 보드에서 답할 수 없다. 머리줄의 "판단 대기" 수에는 들어가지만
   (`project-board.tsx:168`), 카드 id가 `@goal`이라 어느 카드의 패널에도 나오지 않는다
   (`board/board-surface.tsx:297`). 사이드바의 판단 대기 함에서는 답할 수 있다.
4. Goal의 끝 결과(merge됨, PR 주소, PR 실패)가 세션 보드의 접힌 "Goal 스케줄" 안에만 있다
   (`chat/board-panel.tsx:774`). PR 주소는 누를 수 없는 글자다(`:730`). 칸반 Goal이 멈춘 뒤에는
   `/kanban`이 `{ active: false }`를 주므로 그 결과가 화면 어디에도 남지 않을 수 있다(확인 필요).
5. 승인을 기다리는 카드를 거절하려면 편집 → 카드 취소 → 확인의 세 단계를 거친다
   (`card-peek.tsx:251-253`의 안내문). 승인은 버튼 하나다.
6. 카드 편집기: 의존 카드를 카드 id의 쉼표 목록으로 적는다(`card-peek.tsx:672-686`). 거의 쓰이지
   않는 네 항목(경계, 위험, 필요한 근거, 사람 판단)이 늘 펼쳐져 있다.
7. 카드가 왜 멈췄고 어디서 고치는지 알기 어렵다. 서버가 주는 `failures`, `replans`,
   `conflictRounds`를 보드가 보이지 않는다(`kanban/contracts.ts:114-123`. 제보 화면만
   비슷한 수를 보인다, `report/report-bundle.tsx:411`). 판단 문구가 "카드 작업 폴더에서 확인", "직접 해결함"을 말하지만
   그 폴더의 경로와 브랜치가 화면에도 API에도 없다. 판단 내용에서 경로를 뺀 것은 의도다
   (`kanban/human-decision-schema.ts:8`). 서버에 읽기를 더한다(017).
8. 진행 중인 카드가 무엇을 하는지 보드에서 볼 수 없다. Work Trace는 채팅 쪽 패널이라 보드 Sheet
   뒤에 깔리고, 카드와 Work Trace 작업을 잇는 값이 화면 계약에 없다(서버에는
   `kanban_card_runs.trace_attempt_id`가 있다). 서버와 화면을 함께 바꿔야 한다.
9. 같은 표시가 여러 벌이다. "자동 Plan 작성 멈춤"의 설명문이 세 곳, 보드 루프 상태가 네 곳,
   "칸반으로 전환"이 세 곳에 있다(`board-panel.tsx:164,315,489`, `project-board.tsx:417`).

버린 것(설계다): 펼친 열이 모두 같은 폭인 것(`docs/decisions.md:2097`). 다른 대화의 카드 위에
놓는 드롭을 거절하는 것과 이관을 카드 패널에서만 하는 것(2026-10-22).

### 보지 않은 것

- Work Trace 패널의 안쪽, 제보 화면의 안쪽.
- 접근성(키보드 순서, 화면 읽기 프로그램)과 좁은 화면 배치는 훑어보기만 했다.
- 브라우저에서 실제로 띄워 보지 않았다. 운영자의 dev가 같은 checkout을 쓴다. 판단은 코드와 DB의
  수에서 나왔다.
- 서버 쪽은 008에 필요한 만큼만 읽었다.

## 기능 중복 정리 (2026-11-21)

기준 commit `df4e066f`(브랜치 `goal-alignment-terms`). 사용자 요청: 중복된 기능은 합치고, 겹치는
기능은 상위 추상화로 묶는다. 조사는 도메인 넷(오케스트레이션, 채팅 런타임, 기억·도구, 공급자·설정)으로
나눠 했고, 계획마다 인용한 코드는 조언자가 직접 다시 읽었다.

군집 11개와 다룰 계획(번호는 쓰는 대로 붙인다):

1. 사람에게 묻는 통로 6개 이상(정적 승인, permission gate, RelayedApprovals, CardApproval, HumanDecision,
   불확실 부작용 3벌). 판단 대기 함은 둘만 센다. → `WaitingForUser` 하나와 함 하나. 계획 예정.
2. 작업 끝·끼어들기 장부 4개(`work_tasks` 알림, `background_tasks.delivered_*`, `session_dispatches`,
   `queued_messages`) + 메모리 `kanbanAttention`. → 세션 inbox 표 하나. 계획 예정.
3. 위임 4길, 카드 시도 한 번이 5곳에 기록, `"kanban:"` 접두사. 계획 예정.
4. Goal/Plan 모드 차이 소멸, durable 스택 2벌, 카드 보류 개념 4개, GoalOrder·GoalSchedules. 모드는 없애기로 사용자가 정했다(2026-11-21). 처음 Plan의 승인을 누가 하는지가 남은 질문이다. 계획 예정.
5. 모델 고르기 대여섯 갈래. 요약이 전역 모델로 돎 → **024**. 역할 모델 API·화면 통합은 계획 예정.
6. "배운 것" 저장소 8곳, improve 결과가 복사 버튼뿐(섬), improve가 앱 자신의 반복 실패를 버림. 계획 예정.
7. 코드 실행 4길, 카드 지침(`save_code_skill`)과 `project_command` 거부의 모순, 카드에 `find_skill` 없음.
   사용자 결정(검증자도 같은 권한) → **027**.
8. RRF 2벌, 기억 단서 주입 2벌, 쓰이지 않는 정책 상수 → **025**.
9. 이미지·provider tools의 닿지 않는 경로, `OPENAI_API_KEY` 환경 변수. 계획 예정.
10. worktree 정체성 2벌, hidden=보관=자동 접힘, 비밀값 저장소 4벌, 설정 범위 혼재. 계획 예정.
11. 상태 읽기 4길 + 사이드바 2초 폴링, lease 제거 중단, 컨텍스트 표시 불일치 → **026**(표시). 폴링·lease는 계획 예정.

### 실행 방식

계획마다 실행 에이전트 하나가 자기 worktree에서 고치고 commit한다. worktree는 `df4e066f`에서
만든다. 조언자는 diff를 검토하고 이 표를 고친다. 조언자는 merge·push하지 않는다.

2026-11-22: 사용자가 요청해 024–027을 `goal-alignment-terms`에 merge하고 `main`을 그 지점(`92e33b52`)으로
올렸다. push는 하지 않았다. merge 뒤 두 typecheck, 루트 lint, 바뀐 테스트(서버 157개, jsdom 11개, 브라우저
9개)가 통과했다.

## 일관성 규칙 구현 (2026-11-22)

규칙은 `plans/consistency-rules.md`의 R1–R16이다. 기능 그래프의 충돌 군집 11개를 사용자와 토론해 정했다.
계획은 규칙이 서로 기대는 순서로 쓴다. 계획마다 `docs/decisions.md` 항목을 함께 넣는다.

| 묶음                | 규칙                                                                 | 계획                                                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 바닥             | R15 lease 제거                                                       | **028**(동작), **029**(코드 걷어내기)                                                                                                                                                                                                                                                             |
| 1. 바닥             | R8 앱이 모델에게 전할 알림은 한 표에                                 | **030**(표와 서비스, 다른 대화의 메시지), **035**(이름을 orchestrator notifications로, 사용자 메시지는 따로), **033**(끝난 백그라운드 작업. 035가 merge됐으니 새 이름으로 다시 찍는다). 끝난 하위 작업·보드 옮기기, 사용자 메시지 큐가 같은 전달 값 쓰기, `notify_session` 깨우기, 화면은 쓸 예정 |
| 2. 사람에게 묻기    | R1 처음 Plan의 승인자                                                | **031**(동작과 입력창, 병합됨), **032**(저장된 `mode` 값과 move `"plan"`을 지운다)                                                                                                                                                                                                                |
| 2. 사람에게 묻기    | R2 판단 대기 함에 전부, R3 같은 질문 같은 선택지                     | **034**(도구 승인의 답을 승인/거절 둘로). 판단 대기 함, 경로 셋 합치기, 부작용 불확실 확인 합치기는 쓸 예정                                                                                                                                                                                       |
| 3. 모델             | R9 역할 표와 "모델" 페이지, R10 계정 포함, R16 이미지 역할           | 쓸 예정                                                                                                                                                                                                                                                                                           |
| 4. 스크립트와 명령  | R12 파서와 예외 기준, R13 "묻지 않음", R11 개선 항목의 "Goal로 시작" | 쓸 예정                                                                                                                                                                                                                                                                                           |
| 5. 맡긴 일과 저장소 | R5 맡긴 일 한 종류, R4 플래너 쓰기 거절, R6·R7 저장소 단위           | 쓸 예정                                                                                                                                                                                                                                                                                           |
| 6. 화면 범위        | R14 설정 창을 앱과 프로젝트로 나누기                                 | 쓸 예정                                                                                                                                                                                                                                                                                           |

### 계획을 쓰며 확인한 것

- 028: 한 대화의 run은 lease 없이도 한 번에 하나다(`liveRuns.claim`, `run_in_progress`). 화면은 거절된
  메시지를 대기열에 넣는다(`chat-panel.tsx`의 `onNotTaken`). `dev-agent-chat-boundary.test.ts`의 423 단언은
  보안 경계가 아니라 탭 사이의 양보를 본 것이고, 다른 origin을 막는 403 단언은 그대로 남는다.
- 028: 독립 검토(새 문맥의 에이전트)를 한 번 거쳐 다시 썼다. 빠진 호출 자리 둘, 깨질 테스트 둘, 맞지 않던 Verify를
  고쳤다. 같은 승인에 두 번째로 온 답은 `no_user_turn`으로 거절될 것으로 보고, 새 테스트가 확인하게 했다.
- 030: 장부 다섯을 조사했다. 끝난 하위 작업의 장부는 `work_tasks`가 아니라 `parent_notifications` 표다. 알림
  멈춤(`parent_notification_holds`)은 세 장부가 함께 읽는다. 보드의 호출(`kanbanAttention`)은 메모리에만
  있지만 보드 루프가 저장된 보드 상태에서 매번 다시 만들므로 재시작해도 잃지 않는다. 그래서 R8의 내 기본값
  "보드 호출도 영속으로 둔다"는 내구성이 아니라 한 곳에서 보이게 하려는 것이다. 그 단계의 계획에서 다시 본다.
  `notify_session`은 지금 어느 권한 모드에서도 승인을 묻지 않고, 쉬는 대화를 깨우지 못한다.
- 030: 독립 검토를 한 번 거쳐 고쳤다(2026-11-22). 옛 표를 직접 읽는 테스트 파일 하나
  (`notify-session-record.test.ts`)가 빠져 있었고, 테스트의 SQL은 표 이름만 바꿔서는 돌지 않았다. 테스트 수는
  20이 아니라 19다. migration 테스트는 단계를 "마지막"이 아니라 이름으로 찾는다.
- 032: 독립 검토를 한 번 거쳐 고쳤다(2026-11-22). 상태 수 문서 `docs/goal-transitions.md`와 golden 파일 셋이
  `mode`를 담고 있어 테스트가 깨질 곳이었다.
- 033: 장부마다 "알렸다"를 적는 때가 다르다. 백그라운드 작업은 run이 잡는 순간 적고 재시작 때 되돌리지 않는다.
  끝난 하위 작업은 잡는 순간 적고 재시작 때 끝나지 못한 run의 것을 되돌린다. inbox는 run이 끝날 때 적는다.
  알림 멈춤도 inbox의 `claim`만 본다. 033은 백그라운드 작업을 inbox의 규칙으로 맞추고 달라지는 동작 다섯을
  계획에 적었다. 그중 "멈춘 대화의 run은 끝난 백그라운드 작업도 듣지 않는다"는 조언자가 정한 기본값이다.
- 033: 독립 검토를 한 번 거쳐 고쳤다(2026-11-23). 끝을 적는 `UPDATE`와 inbox 넣기를 한 transaction으로 묶으면
  `background-tasks.test.ts`의 "an end that cannot be saved …"가 세는 TEMP 표의 행이 rollback으로 사라진다.
  묶지 않고, id가 이미 있으면 그대로 두는 넣기(`putOnce`)와 시작할 때 빠진 행 채우기로 바꿨다. 폴더 README
  셋의 고칠 줄, 재시작 뒤 서비스를 다시 얻는 것, lint가 막는 타입 좁히기 꼴도 적었다.
- 034: 계획의 검색이 `-g '!*.md'`라서 `packages/memory-agent/src/loop/README.md:33`의 `editedArgs` 구절을
  놓쳤다. 실행자가 commit 전에 멈춰 물었고, 그 구절만 지워 Step 1 commit에 넣게 했다. 계획에서 남은 곳을 셀 때는
  문서도 함께 찾는다.
- 034: 이미 저장된 옛 승인 요청은 `responseSchema`에 `editedArgs`가 남아 있어, 그것을 담은 답이 검사를 지난다.
  서버는 그 값을 버리고 보여 준 인자로 돌린다. 화면은 그 값을 보낸 적이 없다.
- 034, 035: 두 브랜치가 `docs/decisions.md` 끝에 각자 항목을 더해 둘째 merge에서 충돌했다. 두 항목을 모두
  남겼다. 함께 실행하는 계획이 둘 다 그 파일 끝에 쓰면 매번 이렇게 된다.
- 035: 옛 migration 단계 안의 `session_inbox`와 주석(`migrations.ts` 1838행 근처의 "durable inbox row")은
  그대로 두었다. 이미 적용된 단계의 글이다.
- 035: 서버가 모델 입력에 넣는 것 다섯 종류를 코드에서 읽어 견줬다(2026-11-23). 여섯 군데가 다르다.
  (1) "전했다"를 적는 때: 사용자 메시지는 넣는 순간 적고 되돌리지 않는다. 하위 작업과 백그라운드는 잡는 순간
  적고 run이 못 끝나면 되돌린다. 다른 대화의 메시지는 run이 끝날 때 적는다. 보드의 호출은 run을 시작하기 전에
  지우고 시작이 거절돼도 돌려놓지 않는다. (2) 재시작: 사용자 메시지는 모두 보류가 된다. 하위 작업은 들은 run이
  `completed`가 아니면 되돌린다. 백그라운드는 되돌리지 않는다. 다른 대화의 메시지는 들은 run이 `completed`나
  `interrupted`면 전한 것으로 둔다. (3) 승인 대기로 멈춘 run이 들은 것을 하위 작업의 재시작 처리만 "못 들었다"로
  본다. (4) 사용자가 멈춘 대화에서 다른 대화의 메시지는 잡지 않고, 하위 작업과 백그라운드는 run이 돌면 듣는다.
  (5) 사용자 메시지만 tool 결과 직후에 들어가고 나머지는 모델 호출 전마다 들어간다. (6) 자동 run이 알림을 잡은
  뒤 시작을 거절당하면 돌려주는 코드가 없다. 깨우는 순서는 사용자 메시지, 보드의 호출, `wake` 알림이고 한 번에
  하나다.
- 035: 사용자 메시지의 `steer`는 쓰던 답을 끊고(tool 호출을 시작한 답은 못 끊는다) run이 끝나면 서버가 다음
  turn으로 보낸다. `queue`는 끊지 않고 다음 tool 결과 직후에 넣거나 run이 끝난 뒤 다음 turn으로 보낸다. 둘 다
  쓴 쪽은 사용자이고, 갈리는 것은 "언제 전하나"다. 그래서 표는 둘로 두고 전달 값만 같이 쓰기로 했다.
- 029: 독립 검토를 한 번 거쳐 고쳤다(2026-11-22). endpoint가 `headers`·`query` schema를 선언하는 동안에는 client
  요청에서 그 키를 지울 수 없어, 앞 단계는 `headers: {}`·`query: {}`를 두고 마지막 서버 단계에서 지우게 했다.
  Verify의 `rg`가 README를 잡던 것, 없는 테스트 폴더 이름, `holder`를 예시 값으로만 쓰는 전송 테스트의 처리를
  고쳤다.
- 028: route 핸들러 폴더 `apps/agent/app/.server`는 이름이 점으로 시작해 `rg`가 기본으로 건너뛴다. 같은 lease
  검사(`checkHolder`)가 거기에 하나 더 있었다. 이 저장소에서 쓰임을 찾을 때는 `rg --hidden`을 쓴다.
