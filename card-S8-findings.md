# 카드 S8 조사 결과 (2026-11-13)

test-failures 스킬 기준 실패 6건(code-skills 4·io-range 1·background-tasks 1)과
package-smoke의 keychain 검사 1건을 조사한 판정 기록이다. 기준 커밋: `12b03223`.

## 수리한 것 — io-range 1건 (코드 문제, 이 Goal이 건드린 파일)

- 실패: `tests/io-range.test.ts > saved results page UTF-16 offsets across UTF-8 blocks,
  NULs and surrogate boundaries` — `ResultPageReadFailed.make`에서 죽음
  (src/memory/result-pages.ts:79 `failed`).
- 원인: 이 Goal 커밋 `364ca66f`(하위 에이전트 대화를 부모 아래 세션으로 기억에 남긴다)가
  `result-pages.ts`의 metadata/block 질의에 세션 트리 CTE
  (`SELECT t.id FROM sessions s JOIN sessions t …`)를 넣었다. 이 커밋은 result-pages.ts를
  바꾼 유일한 커밋이다(12b03223..HEAD 확인). 그런데 io-range.test.ts의 피스처는
  `nodes` 테이블만 만들어 `sessions`가 없다.
- 직접 재현(sql-tree-probe 스킬): 피스처 스키마에서 그 metadata 질의를 실행하면
  `no such table: sessions`이 나고, `sessions` 표(최소 열)를 추가하면 정상 행이 나온다.
  테스트 출력의 `ResultPageReadFailed`는 이 SqlError를 감싼 것과 정확히 일치한다.
- 수리: 피스처에 최소 `sessions` 표(`id`, `parent_session_id`)와 루트 행 하나를 추가했다.
  검증 단언은 전혀 약화하지 않았다(패이지 분할 기대값은 그대로).
- 확인: `package-test-files tests/io-range.test.ts` → 5/5 통과. 전체 스위트 재실행에서도
  io-range는 통과(실패 6건 → 5건으로 감소). `vp-check packages/memory-agent/tests/io-range.test.ts`
  → clean.

## 환경 전용으로 입증한 것

### code-skills 4건 + background-tasks 1건 — 중첩 샌드박스(이 Goal과 무관)

- 실패: code-skills.test.ts의 "an approved script runs…", "run_skill runs ts skills…",
  "a script reaches only its approved hosts…", "a script writes the project, /tmp and the
  temp folder…", background-tasks.test.ts의 "shell yields before completion…".
- 실패 출력: `ToolFailed: io_error: write-around (unknown)`,
  background-tasks는 `Operation failed (BackgroundOperationFailed)…`로, 모두 sh 스킬
  실행 경로가 죽은 형태다.
- 메커니즘: run_skill의 sh 실행은 `shell/sandbox-worker.ts`에서
  `@anthropic-ai/sandbox-runtime`의 `SandboxManager.initialize`를 호출한다. 이 초기화는
  필터 프록시용 unix 소켓을 TMPDIR에 바인드하는데, 이 카드 워크트리는 에이전트
  샌드박스(중첩 샌드박스) 안에서 돌고, 그 안에서는 (a) 허용된 모든 짧은 경로(/tmp/claude,
  ~/Library/Caches 등)에서 바인드가 EPERM이고 (b) 워크트리 경로가 91자라 macOS
  sun_path 104자 한계를 넘는 소켓 경로가 만들어진다(EINVAL). 초기화가 죽으면
  SandboxUnavailable → ask 모드에서는 그대로 실패(full 모드만 미샌드박스 폴백) →
  run_skill 결과가 `io_error (unknown)`, background-tasks는 그 실패가
  BackgroundOperationFailed로 저장된다.
- 증거: S4 카드가 남긴 `sandbox-nest-diagnosis` 스킬이 이 대화에서 같은 결과를 재현한다
  (TMPDIR bind FAIL EPERM /tmp/claude/srt-bind-probe.sock, home-caches bind FAIL EPERM).
  이는 카드 코드가 아니라 앱 자체의 도구 실행 샌드박스이고, S4가 바꾼 파일
  (.agents/skills/vp-check/scripts/run.sh, card-S4-changed-files.md)과 무관하다.
- 재현 파일 무관성: 실패 파일 3개(tests/code-skills.test.ts, tests/agents/background-tasks.test.ts,
  tests/io-range.test.ts)와 관련 소스(shell/sandbox.ts, shell/sandbox-worker.ts,
  tools/approved.ts, tools/failure.ts, shell/run.ts)를 git으로 대조했다. 12b03223..HEAD에서
  shell/run.ts의 변경은 OTEL_* 환경변수 필터 추가뿐이고, 위 나머지는 전부 미변경이다.
- 참고: 이 5건은 "일반 터미널(중첩 샌드박스 밖)"에서는 통과한다는 것이 S4 기록이고,
  카드 관련 2건(old-cd/keys)은 파일 단독·소규모 묶음 실행에서는 not_found로 실패하고
  전체 스위트에서만 통과한다(실행 형태 의존, 이 카드에서 따로 분류하지 않음).

### package-smoke keychain 검사 — 환경 전용(코드 문제 아님)

- 실패: `✗ keychain addon loads (Kagi status) — 500`.
- 메커니즘: smoke는 실행 파일을 `CONTEXT_AGENT_SECRET_DIRECTORY` 없이(→ OS keychain
  백엔드) 띄우고, `GET /api/settings/kagi`의 Kagi.status는 `secrets.get("kagi-api-key")`의
  SecretStoreFailed를 잡지 않아 500이 된다. 이 워크트리는 에이전트 샌드박스 안에서 돌고,
  그 안의 macOS 기본 keychain 접근은 차단된다.
- 증거 1(diag-env 스킬): `@napi-rs/keyring` darwin-arm64 애드온은 정상 로드되고
  `new AsyncEntry(...).getPassword()`가 `Platform failure: A default keychain could not be
  found.`를 내놓는다. 애드온 부재·아키텍처 불일치가 아니다(lockfile·설치·arch 모두 정렬).
- 증거 2(smoke-keychain-probe 스킬, 같은 실행 파일 A/B):
  - A(smoke와 동일, 시크릿 env 없음): `{"error":"keychain_failed","reason":"read"}` HTTP 500
  - B(CONTEXT_AGENT_SECRET_DIRECTORY+KEY, 파일 백엔드):
    `{"keyRegistered":false,"enabled":false}` HTTP 200
  같은 바이너리에서 시크릿 백엔드만 바꿔 500→200이 되므로, 코드 결함이 아니라 이 환경의
  keychain 접근 차단이 원인이다.
- 코드 무관성: 12b03223..HEAD에서 runtime/keyring.ts, config/secrets.ts, kagi/kagi.ts,
  kagi/contracts.ts, api/app-api/settings.ts, smoke-package.ts, memory-agent package.json은
  전부 미변경(git 확인).

## 검증 보조 스킬(이 대화에서만 실행 가능, 저장소 커밋 대상 아님)

- smoke-keychain-probe — 패키지 실행 파일을 A/B로 띄워 /api/settings/kagi 응답을 보여준다.
- sql-tree-probe — result-pages 트리 CTE가 피스처 스키마에서 실패함을 재현한다.
- git-range-diff / git-range-diff-name-status / git-log-path — 범위 diff·log 조회.

## 이 카드가 남긴 변경

- packages/memory-agent/tests/io-range.test.ts (피스처에 sessions 표 추가, 수리)
- 이 파일(card-S8-findings.md)
