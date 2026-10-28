# bench

## Overview

`packages/memory-agent/bench`는 memory-agent의 파일 도구와 코드 스킬 지연 시간을 재는 Vitest 벤치마크 디렉터리이다. 모델·HTTP·UI 없이 도구 실행 경계에서 잰다. 파일은 `tools.bench.ts` 하나이고 `vp test bench`로 실행한다. 실행하면 OS 임시 디렉터리에 합성 저장소 두 개(plain, git)를 만들고 `memoryAgentLayer`로 실제 에이전트 레이어를 띄운다. 그다음 `list_files`·`search_files`·`read_file`·`run_skill`을 모델처럼 마지막 페이지까지 넘기며 호출해 잰다. export하는 심볼은 없고 벤치마크 등록만 하는 진입점이다.

## Interface

- `tools.bench.ts` — `vp test bench`로 실행하는 Vitest 벤치마크 진입점. export 심볼은 없고 `describe("file tools (3,000 files)")`·`describe("code skills")` 아래에 벤치를 등록한다
- `makeRepository` (모듈 내부, `Effect.fn("ToolBench.makeRepository")`) — 디렉터리 40개 × 파일 75개(각 120줄, 앞쪽 60개 파일에만 `needle` 줄)와 6000줄짜리 `big.txt`(CRLF·이모지 포함)를 만든다. `git=true`이면 `git init/add/commit`까지 한다
- `listAll` / `searchAll` / `readAll` (모듈 내부) — `nextOffset`·`nextCursor`·`nextStartLine`을 따라 마지막 페이지까지 도구를 다시 부른다. `readAll`은 2000줄 단위로 읽고 페이지가 10개 미만이면 throw한다
- `Page` (모듈 내부 Schema.Struct) — 도구 응답에서 페이지 정보(`snapshot`, `nextOffset`, `nextCursor`, `nextStartLine`)만 디코드하는 스키마
- `Call<E>` (모듈 내부 타입) — 모델처럼 JsonValue 입력으로 도구를 부르는 `(input: JsonValue) => Effect.Effect<JsonValue, E>`
- 의존 심볼: `memoryAgentLayer`, `Projects.add`, `FileTools.toolsFor`, `ApprovedTools.toolsFor(project, "gate")`, `callTool`(`tests/support/run-tools.ts`), `fakeEmbedderLayer`, `MorphAnalyzer.disabled`, `SecretStore.memory`, `isTruthy`, `optionalProperty`

## Invariants

- 벤치 레이어는 `memoryAgentLayer`에 `embedder: fakeEmbedderLayer`, `morphAnalyzer: MorphAnalyzer.disabled`, `interpretAutomatically: false`, `secrets: SecretStore.memory`, `skillsHome: join(base, "home")`를 넘긴다. 실제 임베더·형태소 분석·키체인을 쓰지 않는다
- 모든 경로는 `fs.makeTempDirectory` 결과에 `fs.realPath`를 적용한 `base` 아래에 둔다(storage, home, plain, git)
- git fixture는 `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `stdin: "ignore"`로 실행해 사용자 git 설정을 무시한다. 종료 코드가 0이 아니면 `Cause.UnknownError`로 실패한다
- `afterAll`의 정리 순서: 에이전트 `runtime.dispose()`, 그다음 `base` 재귀 삭제, 마지막으로 `platformRuntime.dispose()`
- 페이지 순회는 `nextOffset`을 넘길 때 이전 페이지의 `snapshot`도 함께 넘긴다(`optionalProperty`). 검색은 같은 query에 `cursor`를 더해 다시 부른다
- `run_skill` 벤치 전에 `save_code_skill`로 `print-ok` 스킬(`runtime: "sh"`, `script: "printf ok"`)을 plain 프로젝트에 저장해야 한다
- 검색 기대값: needle 파일 60개 × `line % 10 === 0`인 줄 12개 = 600 매치(벤치 이름에 적힘)

## Side Effects

- 파일 시스템: OS 임시 디렉터리에 `memory-agent-bench-*` 디렉터리를 만든다. 그 안에 `.ts` 파일 3000개와 `big.txt`를 쓴다. `afterAll`에서 재귀 삭제한다
- 자식 프로세스: git fixture 저장소에서 `git init -q`, `git add -A`, `git commit -qm fixture`를 실행한다
- 자식 프로세스: `run_skill` 벤치가 `sh`로 `printf ok`를 실행한다
- SQLite 등 저장소: `memoryAgentLayer`가 `join(base, "storage")` 아래에 상태를 쓴다. `Projects.add`로 프로젝트 두 개를 등록하고 `save_code_skill`로 스킬을 저장한다
- 모듈 최상위 await: import 시점에 `ManagedRuntime` 두 개를 만들고 fixture 생성과 도구 준비를 바로 실행한다

## Verification

- Run: `vp run memory-agent#typecheck`
