## packages/memory-agent/src/files/README.md

- `gitGrepFilesEffect`는 이제 위치 인자가 아니라 옵션 객체 `{ root, directory, query, caseSensitive, limit }`를 받는다. 일치 파일이 `limit`개를 넘으면 좁히기를 버리고 null을 돌려준다. README는 `limit`와 이 null 경우를 말하지 않는다.
- 새 export `gitNames({ stdout, limit })`가 Interface에 없다. `-z` 출력에서 이름을 `limit + 1`개까지만 읽고 `{ names, truncated }`를 돌려주며, git grep과 ls-files가 함께 쓴다.
- Invariants의 "Git 출력 상한은 git grep 64 MiB, ls-files 256 MiB이다. 넘거나 PlatformError가 나면 null로 폴백한다"는 더 이상 맞지 않는다. 바이트 상한은 없어졌다. ls-files는 `walkLimit`(50_000)개에서 읽기를 멈추고 `truncated`로 알린다(폴백하지 않는다). 멈춘 git은 종료를 기다리지 않고 Scope와 함께 끝난다. git grep은 일치 파일이 `limit`를 넘을 때 null이다.
- Interface의 `walkLimit`은 "순회 상한"으로만 적혀 있지만, 이제 Git 목록에도 같은 상한이 걸리고 `truncated`는 walk와 Git 둘 다에서 켜진다.
- Side Effects의 "검색은 Cache와 `Effect.forkScoped`로 파일을 미리 읽는다"는 낡았다. 이제 `Stream.mapEffect(..., { concurrency: readAhead + 1 })`로 미리 읽고 `Stream.scanEffect`로 순서대로 모으며, 페이지가 차면 `Stream.takeUntil`로 멈춘다. `Cache`와 `Effect.forkScoped`는 이 폴더에 없다.
- `createTextPageReader`는 이제 팩토리 함수(`() => ...`)가 아니라 `Effect`(`Effect.gen`)이다. 줄 색인 캐시도 `MutableHashMap`에서 `Ref`로 바뀌었다. README는 함수처럼 적고 있다.

## packages/memory-agent/src/shell/README.md

- Invariants의 "출력 캡처는 stream마다 앞 8KiB와 뒤 56KiB만 남기고"가 낡았다. `run.ts`의 `headBytes`는 이제 2 KiB, `tailBytes`는 14 KiB다(합 16 KiB, 컨텍스트 크기에 맞춘 상한).

## packages/memory-agent/src/skills/README.md

- Interface의 "`maxSkillBytes`(256KiB)"가 낡았다. 새 export `maxSkillCharacters`(32_000자)가 기준이고, `maxSkillBytes`는 `maxSkillCharacters * 3`(96_000바이트, UTF-8 최대 3바이트/UTF-16 단위)로 정해진 파생 상한이다. Interface에 `maxSkillCharacters`가 없다.
- Invariants의 "SKILL.md가 `maxSkillBytes`를 넘으면 `too_large`"와 "크기는 lstat 때와 읽은 뒤에 두 번 확인한다"는 일부만 맞다. 바이트 검사 뒤 디코드한 텍스트가 `maxSkillCharacters`를 넘어도 `too_large`가 된다.

## packages/memory-agent/src/memory/embedding/README.md

- Invariants·Side Effects에 embed-worker가 닫힐 때 모델을 내려놓는다는 내용이 없다. 워커는 로드한 모델의 `dispose()`를 워커 Scope finalizer에 등록하고, 호스트가 워커를 닫으면 onnxruntime 세션을 스레드 종료 전에 해제한다(`embedding_model_dispose_failed`로 실패만 기록).
- 워커의 `Embed` 실행은 이제 `Effect.uninterruptible`이다. 중단된 요청도 진행 중인 세션 실행이 끝날 때까지 기다리므로, 실행 도중 모델이 dispose되지 않는다. README의 "ONNX 추론은 그 자리에서 중단할 수 없다. 진행 중 작업은 `terminate`로만 멈춘다"에 워커 안 동작으로 이 점이 빠져 있다.

## packages/memory-agent/src/kanban/README.md

- README 이후 바뀐 것은 반복 구조뿐이다(보드 루프 `Effect.repeat`, 검증 라운드 `Effect.repeat({ until, times: 2 })`, Goal 병합 라운드 `Stream.paginate` + `Stream.take(mergeRounds)`). 적힌 계약과 어긋나는 곳은 없다.
- 다만 다음 동작은 README에 없다(이전부터 빠져 있던 부분). `orchestrator.ts`의 카드 검증은 최대 3라운드다. `merge-queue.ts`의 Goal 병합은 `mergeRounds`(3)라운드까지 다시 검증하고, 모든 라운드에서 대상 브랜치가 움직였을 때만 merge 상태를 `TargetMoving`으로 남긴다.

## apps/agent/scripts/README.md

- Side Effects의 "타이머(`Effect.sleep`, timeout) 기반 폴링"이 낡았다. `dev.ts`의 백엔드 health 대기와 `smoke-package.ts`의 `until`은 이제 `Effect.retry(Schedule.spaced(...))`와 `Effect.timeoutOrElse`로 폴링하고 `Effect.sleep`을 쓰지 않는다. 간격은 health 100ms(요청마다 1초 timeout), smoke 250ms다.
- `dev.ts`의 health 판정은 이제 기대 `buildId`와 `status: "ready"`를 Literal로 둔 스키마 `Ready`의 디코드 성공 여부다. Invariants의 판정 조건 자체(2xx, buildId 일치, ready, 30초)는 그대로 맞다.
- `dev.ts`의 종료 동작이 README에 없다. 첫 SIGINT·SIGTERM·SIGHUP은 web과 backend에 같은 신호를 보낸 뒤 span 수집기를 멈추고 자기 매니페스트를 지운다. 종료 중 두 번째 신호는 web·backend·수집기를 모두 `SIGKILL`하고 매니페스트를 지운다(`forceStop`, af30b085부터 web 포함). 핸들러가 읽는 `web`·`stopping`은 `MutableRef`다.

## apps/agent/server/README.md

No drift detected

## lint/anti-slop/README.md

- 445a7913에서 플러그인이 내용 변경 없이(100% rename) `tools/oxlint/anti-slop`에서 `lint/anti-slop`으로 옮겨졌다. Overview의 경로 `tools/oxlint/anti-slop`와 specifier `./tools/oxlint/anti-slop/index.ts`는 이제 `lint/anti-slop`, `./lint/anti-slop/index.ts`다.
- Invariants의 "`agentAndVendoredIgnorePatterns`에 `tools/oxlint/anti-slop/**`가 있다"는 이제 `lint/anti-slop/**`다.
- Invariants의 `anti-slop-effect` specifier `./tools/oxlint/anti-slop/effect/index.ts`는 이제 `./lint/anti-slop/effect/index.ts`다.

## lint/anti-slop/rules/README.md

- Overview의 `tools/oxlint/anti-slop/rules`와 공통 로직 위치 `tools/oxlint/anti-slop/shared`는 이제 `lint/anti-slop/rules`, `lint/anti-slop/shared`다.

## lint/anti-slop/shared/README.md

- Overview의 `tools/oxlint/anti-slop/shared`는 이제 `lint/anti-slop/shared`다.

## lint/anti-slop/effect/README.md

- Overview의 specifier `./tools/oxlint/anti-slop/effect/index.ts`는 이제 `./lint/anti-slop/effect/index.ts`다.

## lint/anti-slop/effect/rules/README.md

No drift detected

## tools/oxlint/README.md

- 이 문서 전체가 낡았다. `tools/oxlint`에는 이제 이 README 하나만 있고, 설명하는 플러그인은 `lint/anti-slop`으로 옮겨졌다. `[./anti-slop/README.md](./anti-slop/README.md)` 링크는 깨졌다. 폴더와 README를 지우는 것이 맞다.
- 새 상위 폴더 `lint/`에는 이에 해당하는 blueprint README가 없다(`lint/anti-slop/README.md`만 있다).

## tools/README.md

- 하위 폴더 목록의 `[oxlint](./oxlint/README.md)` — "저장소 전용 Oxlint JS 플러그인(`anti-slop`, `anti-slop-effect`)" 항목이 낡았다. 플러그인은 `lint/anti-slop`에 있고, `tools`는 이제 개발 도구만 둔다(AGENTS.md: "lint에는 이 저장소의 커스텀 린트 규칙(anti-slop Oxlint 플러그인)을 둔다").
- Overview의 "하위 디렉터리(`chat-store-check`, `oxlint`, `profile`)는 각각 독립된 개발용 CLI와 lint 플러그인이다"도 같은 이유로 낡았다. 하위 디렉터리는 `chat-store-check`와 `profile`(개발용 CLI)이다.

## tools/profile/README.md

No drift detected

## tools/chat-store-check/README.md

No drift detected

# 수정 후 재검사

## packages/memory-agent/src/files/README.md

No drift detected

## packages/memory-agent/src/shell/README.md

No drift detected

## packages/memory-agent/src/skills/README.md

No drift detected

## packages/memory-agent/src/memory/embedding/README.md

No drift detected

## packages/memory-agent/src/kanban/README.md

No drift detected

## apps/agent/scripts/README.md

No drift detected

## lint/README.md

No drift detected

## lint/anti-slop/README.md

No drift detected

## lint/anti-slop/rules/README.md

No drift detected

## lint/anti-slop/shared/README.md

No drift detected

## lint/anti-slop/effect/README.md

No drift detected

## lint/anti-slop/effect/rules/README.md

No drift detected

## tools/README.md

No drift detected

## tools/profile/README.md

No drift detected

## tools/chat-store-check/README.md

No drift detected

## README.md

No drift detected
