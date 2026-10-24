# 셸 스킬 샌드박스 설계

2026-10-14. 결정 요약은 [decisions.md "셸 스킬 샌드박스 (#22)"](./decisions.md#셸-스킬-샌드박스-22-2026-10-14)에 있다. 이 문서는 배경, 구조, 정책, 검증, 남은 한계를 함께 적는다.

2026-10-25: 셸 스킬은 코드 스킬의 sh 종류가 됐다. 저장 도구는 `save_code_skill`(`program: { runtime: "sh", script, network }`)이고, 이 문서의 샌드박스는 sh 스킬에 그대로 적용된다. ts 스킬은 이 샌드박스가 아니라 코드 샌드박스(QuickJS)에서 돈다. 결정은 decisions.md "셸 스킬을 코드 스킬로 넓힌다"에 있다.

## 배경

- `run_shell`을 없애고 호스트 명령은 프로젝트 셸 스킬(`.agents/skills/<name>/scripts/run.sh`)로만 실행한다. 관련 결정은 decisions.md의 "`run_shell`을 셸 스킬로 바꿈"이다.
- 스크립트는 저장 때 한 번 승인한다. 그 뒤에는 인자만 바꿔 묻지 않고 실행된다. 그래서 승인 한 번이 허용하는 범위를 실행 환경에서도 좁혀야 한다.
- 사용자 지적: 승인 카드에 "네트워크 필요" 같은 표시만 보이면 무심코 승인하기 쉽다. 사용자가 실제로 판단할 수 있는 단위로 보여 줘야 한다.

## 목표와 비목표

- 목표
  - 스크립트가 프로젝트·임시 폴더·캐시 밖에 쓰지 못하게 한다.
  - 자격증명과 앱 저장소를 읽지 못하게 한다.
  - 네트워크는 사용자가 이름을 보고 승인한 호스트로만 나가게 한다.
  - 여러 세션·프로젝트의 동시 실행이 서로의 허용 범위를 공유하지 않게 한다.
- 비목표
  - 허용한 호스트 안에서 오가는 내용은 검사하지 않는다. TLS 종료나 요청 필터는 하지 않는다.
  - Windows 샌드박스는 다루지 않는다. srt의 Windows 지원은 alpha이고, 관리자 권한으로 전용 계정을 설치해야 한다.
  - MCP stdio 서버와 외부 에이전트의 격리는 다루지 않는다. 후속 후보로 둔다.

## 다른 에이전트 사례

| 사례           | 방식                                                                                                                                 | 가져온 것                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Claude Code    | `@anthropic-ai/sandbox-runtime`(srt): macOS Seatbelt와 Linux bubblewrap, 도메인 허용 프록시. 새 도메인은 실행 중에 사용자에게 묻는다 | 라이브러리 자체, 정책 형태             |
| Codex CLI      | workspace-write 샌드박스, 네트워크 기본 끔. 벗어날 때는 이유를 붙여 승인을 요청한다                                                  | 막은 뒤 이유를 붙여 다시 승인받는 흐름 |
| Codex 클라우드 | 환경별 도메인 허용 목록과 프리셋                                                                                                     | 도메인 단위 허용 목록                  |
| Gemini CLI     | Seatbelt 프로필 선택(permissive, restrictive, proxied)                                                                               | 프로필 단위 정책                       |

## 네트워크 승인 모델

### 스킬마다 정확한 호스트 목록

- `save_code_skill`의 sh 프로그램이 `network`를 받는다. 항목 형식은 다음과 같다.
  - 소문자 호스트: `registry.npmjs.org`
  - 와일드카드: `*.github.com`
  - 포트 지정: `api.example.com:443`
  - IP 리터럴: `127.0.0.1:3000`
  - 최대 32개
- 저장할 때 `run.sh` 첫 줄에 `# run_skill network: <호스트…>`를 쓴다.
- 이 줄은 승인 대상 텍스트의 일부다.
  - 호스트 목록은 스크립트와 같은 sha256으로 승인된다. DB에 따로 둘 필요가 없다.
  - 누가 파일을 고쳐 호스트를 늘리면 해시가 달라져 `not_approved`로 거절된다.
  - 저장소에 남으므로 사람과 다른 에이전트도 그 스킬의 네트워크 범위를 읽을 수 있다.
- 모델이 스크립트 본문에 이 줄을 직접 쓰면 거절한다(`network_line`). 그래서 카드에 보이는 `network`가 유일한 출처가 된다.

### 승인 카드와 auto 검토

- 승인 카드
  - 호스트를 하나씩 보여 준다. 목록이 비면 "접속하지 않아요"라고 쓴다.
  - `*.` 항목에는 하위 도메인 전체를 포함한다고 덧붙인다.
  - `localhost`에는 이 앱 서버를 포함한 모든 로컬 서비스에 닿는다는 경고를 붙인다.
  - 쓰기·읽기 제한 요약도 함께 보여 준다.
- auto 검토
  - 호스트가 하나라도 있으면 일상 명령 자동 허용 경로를 쓰지 않고 모델 검토로 보낸다.
  - 검토 지침: 작업에 분명히 필요한 호스트(설치할 때 패키지 레지스트리, fetch할 때 git 호스트)는 허용한다. 다음 경우에는 ask한다.
    - 작업과 무관한 호스트
    - 업로드형 서비스(paste, webhook, 파일 공유)
    - 넓은 와일드카드
    - `localhost`

### 실행 중에 묻지 않는 이유

목록 밖 호스트는 막고, stderr 끝에 붙는 `<sandbox_violations>`로 무엇을 막았는지 모델에게 보여 준다. 모델은 필요할 때만 호스트를 더해 다시 저장하고 승인을 받는다. Claude Code처럼 실행 중에 묻지 않은 이유는 다음과 같다.

1. srt의 묻기 콜백(`SandboxAskCallback`)은 프로세스에 하나이고 `{host, port}`만 받는다. 이 앱은 한 프로세스에서 여러 세션이 동시에 실행되므로, 요청한 실행과 세션을 특정할 수 없다.
2. 묻는 동안 패키지 설치 같은 연결이 시간 초과로 끊긴다.
3. 저장 때 받는 승인은 이미 ask, auto, full 흐름과 auto 검토에 연결되어 있다. 새로운 승인 경로를 만들지 않아도 된다.

## 구조

```
run_skill
  └ CodeSkills.runnable       승인된 텍스트 + 첫 줄의 호스트
  └ sandboxPolicy             프로젝트·저장소·홈 기준 정책
  └ runSandboxed (Scope)
       ├ scratch TMPDIR       acquireRelease로 생성·삭제
       ├ Worker(sandbox-worker)
       │    SandboxManager.initialize(정책, strictAllowlist)
       │    wrapWithSandbox(command) → Wrapped
       ├ runCommand(wrapped)  기존 실행기(프로세스 트리 종료, 출력 보존, 시간 제한)
       └ Finish → annotateStderrWithSandboxFailures → reset → Finished
```

- 파일
  - `src/shell/sandbox.ts`: 정책과 호스트 쪽 수명 관리
  - `src/shell/sandbox-worker.ts`: worker 진입점
  - `src/shell/sandbox-protocol.ts`: 메시지 Schema
- worker를 실행마다 하나씩 띄운다. srt는 정책, 필터 프록시, 위반 기록을 모듈 인스턴스마다 하나씩 가진 싱글톤이다. worker thread는 모듈 그래프가 따로라서 실행마다 독립된 인스턴스가 생긴다.
- worker마다 TMPDIR을 따로 준다. srt는 프록시 소켓 이름을 `srt-mux-<pid>-<n>`으로 짓는데, 같은 프로세스의 worker들은 pid가 같아 충돌한다(`EADDRINUSE`로 확인).
- 명령은 worker가 아니라 호스트가 기존 `runCommand`로 실행한다. 백그라운드 전환, 취소, 출력 보존 규칙이 그대로 유지된다. worker는 명령이 끝날 때까지 프록시를 유지한다.
- 수명
  - 정상 종료, 실패, 인터럽트 모두 Scope가 끝날 때 worker를 terminate하고 scratch 폴더를 지운다.
  - 위반 보고는 5초 안에 오지 않으면 원래 stderr를 쓴다.
  - worker의 `error`·`exit`는 대기 중인 Queue를 `SandboxUnavailable(setup_failed)`로 실패시킨다.
- 오류: `SandboxUnavailable{reason}`. reason은 `unsupported_platform`, `missing_dependencies`, `setup_failed` 중 하나다.
- 패키징
  - srt는 옆 폴더의 보조 바이너리(seccomp, Windows helper, JVM 프록시 agent)를 찾아야 하므로 번들하지 않는다.
  - `requireRuntime` 런타임 패키지로 싣고, `sandbox-worker`는 단일 `.mjs`로 번들한다.
  - 버전은 연구 미리보기라 `0.0.79`로 고정한다.

## 정책

| 항목     | 허용                                                                                                                                                            | 차단                                                                                                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 쓰기     | 프로젝트, `/tmp`, 시스템 임시 폴더, `~/.npm`, `~/.cache`, `~/Library/Caches`, pnpm, yarn, bun, deno, cargo registry·git, go mod, gradle·m2 캐시, `~/.vite-plus` | 프로젝트 `.agents/skills`(스킬은 `save_code_skill`로만 바뀜). srt 기본: 셸 설정, `.git/hooks`, `.git/config`, `.vscode` 등                                                                                                                                                |
| 읽기     | 그 밖의 전체                                                                                                                                                    | `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, gh·gcloud·1Password·Copilot 설정, cargo 자격증명, codex·Claude·Gemini 로그인, `~/.mcp-auth`, 키체인, 쿠키, 브라우저 프로필, 앱 저장소 폴더 |
| 네트워크 | 스킬 `network`의 호스트. 루프백 포트 바인딩·접속은 `localhost`를 적었을 때만                                                                                    | 그 밖의 전체. ssh 기반 git은 프록시를 지나지 못하므로 https remote를 쓴다                                                                                                                                                                                                 |

- 권한 모드는 샌드박스를 풀지 않는다. 경로·자격증명 규칙을 모드가 풀지 않는다는 기존 원칙과 같다.
- 샌드박스를 쓸 수 없는 환경
  - 대상: macOS·Linux가 아닌 OS, bubblewrap·socat이 없는 Linux.
  - ask·auto 모드: 실행을 거절한다(`sandbox_unavailable`).
  - full 모드: 승인 없는 스크립트도 이미 실행하므로 샌드박스 없이 실행한다.

## 검증

- `tests/code-skills.test.ts`(macOS)
  - 프록시를 거친 목록 밖 호스트는 차단되고 `<sandbox_violations>`가 붙는다.
  - 목록에 넣은 IP는 허용된다.
  - 루프백은 기본으로 막히고 `localhost`를 적으면 열린다.
  - `.agents/skills` 쓰기와 앱 저장소 읽기는 `Operation not permitted`로 거부된다.
- 분류기 테스트: 호스트가 있는 일상 스크립트는 자동 허용하지 않는다.
- 실행 파일 확인: 빌드한 런타임 폴더의 `sandbox-worker.mjs`와 srt로 직접 실행했다. 프로젝트 쓰기는 허용됐고 스킬 폴더 쓰기, `~/.ssh` 읽기, 외부 접속은 차단됐다. `smoke-package`도 통과했다.
- 실험: worker 두 개를 동시에 띄워 서로 다른 허용 목록이 섞이지 않음을 확인했다. TMPDIR을 분리하지 않으면 소켓 충돌이 나는 것도 확인했다.
- 아직 하지 않은 것: 실제 모델 대화에서 저장, 승인, 차단 후 재저장으로 이어지는 흐름.

## 남은 한계

- 읽기는 차단 목록 방식이라 목록에 없는 비밀 파일은 읽힌다. 홈 전체를 막고 허용 목록으로 여는 방식은 툴체인 위치(nvm, `.vite-plus`, `.bun`, `.cargo/bin` 등)마다 깨져서 쓰지 않았다.
- 프로젝트 `.env`는 테스트와 실행에 필요해 막지 않는다. 출력으로 새는 위험은 기존 비밀 가리기(R14)에 맡긴다.
- 허용한 호스트로의 업로드는 막지 못한다. srt 문서도 도메인 단위 필터의 한계와 도메인 프론팅 가능성을 적고 있다.
- 캐시 쓰기는 캐시 오염 경로가 될 수 있다.
- 자격증명이 필요한 도구(`gh`, `docker`, 비공개 레지스트리 인증)는 실패한다.

## 열린 질문

- 스킬마다 "샌드박스 없이 실행"을 고를 수 있게 할지. 고를 수 있게 한다면 승인 카드에 강한 경고를 띄운다. 다만 무심코 승인하는 문제가 다시 생길 수 있어 사용자가 결정한다.
- MCP stdio 서버를 같은 방식으로 격리할지. srt README가 MCP 서버 격리를 대표 사용 예로 든다.
- 자주 쓰는 레지스트리 프리셋(Codex 클라우드 방식)을 둘지. 승인 피로는 줄지만 넓은 허용이 된다.
