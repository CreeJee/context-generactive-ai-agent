# 카드 S4 변경 파일 목록 (2026-11-13, 2차 수정)

이 목록은 이 Goal의 카드 S1·S2·S3 커밋(12b03223 이후 HEAD까지)과 S4 통합 카드의
미커밋 변경을 정리한 것이다. 기준 커밋: `12b03223`(스킬 사본 대조).

## S1 — 카드 에이전트·검증자 스킬 카탈로그 (92eaffa6)

- packages/memory-agent/src/kanban/subagent-card-agent.ts
- packages/memory-agent/src/workflow/card-capabilities.ts
- packages/memory-agent/tests/kanban-skills.test.ts (추가)
- docs/decisions.md — "카드 에이전트와 검증자도 스킬 카탈로그와 read_skill을 받는다
  (2026-11-13)"

## S2 — notify_session 영속 dispatch 저장 (93a52f2e, b45b2be2)

- apps/agent/app/entry/chat/message.tsx (라벨 한 줄), apps/agent/app/locales/ko.po
- packages/memory-agent/src/agent/{README.md,chat.ts,orchestrator-message.ts}
- packages/memory-agent/src/db/migrations.ts (session_dispatches 표)
- packages/memory-agent/src/index.ts, src/layers.ts
- packages/memory-agent/src/sessions/{README.md,dispatches.ts} (추가)
- packages/memory-agent/src/tools/{code.ts,effects.ts}
- packages/memory-agent/tests/agent/notify-session-record.test.ts (추가)
- packages/memory-agent/tests/model/**golden**/tool-schema.json,
  tests/model/tool-schema.test.ts
- packages/memory-agent/tests/session-dispatch-migration.test.ts (추가)
- packages/memory-agent/tests/sessions/dispatches.test.ts (추가)
- docs/decisions.md — "세션 dispatch는 표에 영속으로 저장한다 (2026-11-13)"

## S3 — 대상 세션의 다음 run에 전달 (da360df9, b81ed4ad)

- packages/memory-agent/src/agent/dispatch-notifications.ts (추가)
- packages/memory-agent/src/agent/chat.ts, src/agent/orchestrator-message.ts
- packages/memory-agent/src/db/migrations.ts (session_dispatch_claims 표)
- packages/memory-agent/src/sessions/dispatches.ts
- packages/memory-agent/tests/agent/dispatch-delivery.test.ts (추가)
- docs/decisions.md — "대상 세션의 다음 run에 전달한다 (2026-11-13)"

## S4 — 통합 검증 카드(이 카드)의 미커밋 변경

- .agents/skills/vp-check/scripts/run.sh
  - 네트워크 허용 줄 추가: `# run_skill network: github.com
    objects.githubusercontent.com release-assets.githubusercontent.com` —
    wording lint가 Kiwi 모델을 GitHub release에서 받는다(lint/wording/README.md의
    부작용 명세). 이 줄이 없으면 샌드박스 안에서 허용 자체가 안 된다.
  - `NODE_USE_ENV_PROXY=1` 설정 추가 — wording lint의 모델 내려받기가 Node fetch
    (undici)로 이뤄지는데 undici는 프록시 환경변수를 기본으로 무시한다. 샌드박스
    안에서는 프록시 경로만 통과하므로, 이 변수 없이는 모델 내려받기가 실패해
    wording(content) 오류 109개가 난다. 캐시를 지운 뒤 스킬만으로 `vp check`가
    통과하는 것까지 확인했다(빈 캐시 → clean).
- 이 파일(card-S4-changed-files.md) 자체도 카드 폴더 산출물이다.

## S4가 남긴 검증용 코드 스킬(저장소 커밋 대상 아님, 이 대화에서만 실행 가능)

- sandbox-nest-diagnosis — 중첩 샌드박스 원인 진단: 유닉스 소켓 바인드 EPERM
  (/tmp/claude, ~/Library/Caches 등 허용된 모든 짧은 경로), 워크트리 경로 91자 +
  소켓 이름 20자 = 111자 > macOS sun_path 104자(EINVAL). 실행 한 번으로 아래
  "테스트 관문"의 원인 사슬을 재현한다.
- seed-kiwi-model — curl로 모델을 받아 캐시를 채우는 보조 스킬(지금은
  vp-check가 NODE_USE_ENV_PROXY로 자립하므로 불필요).
- probe-srt-init / probe-bind-paths / probe-bind-worktree — 진단 과정의 1회성
  프로브. probe-srt-init의 결과가 핵심 증거: `initialize failed: Error: listen
  EPERM ... /tmp/claude/srt-mux-1132-0.sock` — 샌드박스 밖 코드 없이
  SandboxManager.initialize 자체가 중첩 샌드박스 안에서 죽는다는 직접 재현.
- vp-check-fresh-cache / vp-check-env-proxy — vp-check 자립성 증명용.
- git-log-file, git-show-stat, git-show-msg, git-show-doc, git-show-file,
  git-log-simple, git-merge-base, git-diff-name-status, git-status-short,
  git-status-full — 읽기 전용 git 검사 스킬.
- agent-typecheck, vp-check-full, probe-sandbox-test, probe-srt-init2 — 검증
  보조.

## 테스트 관문의 환경 결론(7 실패)

전체 214파일 1172테스트 중 1165 통과, 실패 7은 전부 OS 샌드박스를 부팅하는
테스트(code-skills 5, background-tasks 1, kanban scheduler/git-worktrees 1+1)다.
실패 지점은 SandboxManager.initialize의 프록시 소켓 바인드이고, 중첩 샌드박스
안에서는 (a) 바인드가 허용된 쓰기 가능 경로가 없고(EPERM), (b) 이 워크트리
경로로는 소켓 경로가 104자를 넘긴다(EINVAL) — 저장소 코드와 무관하다. 일반
터미널(중첩 샌드박스 밖, TMPDIR=/var/folders/...)에서는 같은 코드가 통과한다.
재현: `sandbox-nest-diagnosis` 스킬 실행.

## 검증 환경 보조 파일(카드 폴더 밖, 커밋 대상 아님)

- node_modules/.cache/wording/kiwi-0.24.1/ — wording lint 모델 캐시(vp-check가
  이제 스스로 채운다)
- turbovec 네이티브 애드온 빌드 산출물(node build-turbovec.ts)
- apps/agent/.react-router/ — react-router typegen 산출물(gitignore 대상)
