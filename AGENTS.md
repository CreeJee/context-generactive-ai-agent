<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Project Structure

- apps의 agent는 메인 에이전트 앱으로, 최종 로딩과 채팅 라우터 API를 담당한다.
- packages의 memory-agent는 에이전트 로직을 담당하고, turbovec은 이전 POC의 네이티브 모듈이다.
- tools에는 개발 도구를 둔다. 현재는 anti-slop 도구만 있다.

## common Rules

- 테스트를 추가할때 명확히 필요한 부분만 테스트하고, 과하게 테스트를 만들거나 검증하지 않도록하기 (ex: rust 를 사용하는데 cargo가 있는지 확인하기)
- 하위호환성의 기준점은 github 릴리즈 기준으로만 잡기

## Learning more about Effect

This repository uses the Effect TypeScript library. Before writing Effect code, read
`node_modules/effect/AGENTS.md` completely and follow its links when relevant. For
APIs not covered there, inspect `node_modules/effect/src`.

## 리뷰 가능한 구조와 비동기 수명

- 프로토콜 입출력·디코딩, 도메인 판단, 작업 실행·취소를 책임별로 분리한다. 각 함수와 서비스에서 상태의 소유자, 실패 경로, 자원 종료 경로를 읽을 수 있게 작성한다. 분리는 실제 책임 경계를 기준으로 하고 단순 전달용 계층은 추가하지 않는다.
- 비동기 대기나 작업 관리가 필요하면 현재 설치된 Effect의 기본 도구를 먼저 검토한다. Promise resolver 목록, 실행 중인 작업 Map, 타이머와 AbortController를 조합해 별도 작업 관리기를 만들기 전에 표준 도구로 표현할 수 있는지 확인한다.
- 한 번 도착하는 값이나 요청별 응답을 기다릴 때는 `Deferred`를 사용한다. 요청 ID와 대기자를 연결하는 Map은 필요할 수 있지만, 응답 대기의 성공·실패·취소는 `Deferred`와 Effect의 수명 관리로 표현한다. 대기가 취소되거나 연결이 종료되면 등록을 정리하고, 연결 종료 시 남은 대기자가 무한히 기다리지 않게 한다.
- 키별로 실행 중인 fiber를 시작·교체·중단해야 할 때는 `FiberMap`을 사용한다. 응답 매칭과 실행 작업 관리를 구분하고, 단일 작업이나 단순 조회용 Map에 `FiberMap`을 적용하지 않는다.
- 생산자/소비자 전달과 처리량 제한에는 `Queue`와 bounded concurrency를, 반복 실행에는 `Schedule`을 검토한다. 비동기 경계를 넘는 공유 상태는 `Ref` 등으로 소유권과 갱신 규칙을 명시한다. 도구의 이름만 바꾸는 치환보다 필요한 동작에 맞는 최소 구성을 선택한다.
- 백그라운드 작업은 소유자의 `Scope`에 묶고, 파일·스트림·리스너·프로세스는 `Effect.acquireRelease` 등으로 정리한다. 정상 완료, 실패, interruption, timeout, 연결 종료에서 무엇이 종료되고 해제되는지 명시한다.
- 외부 Promise/callback API와 Effect의 변환은 입출력 경계에 모은다. callback API에는 `Effect.callback`의 interruption cleanup을, 취소 가능한 Promise API에는 전달받은 `AbortSignal`을 연결한다. 내부 도메인 흐름은 Effect로 유지하고, 기존 컨텍스트나 Scope를 잃는 임의의 `runPromise` 호출을 추가하지 않는다.
- 동시성 테스트는 응답 순서가 바뀌는 경우, 취소·연결 종료 후 대기와 자원이 남지 않는 경우 등 실제 계약을 검증한다. 경쟁 조건은 gate/`Deferred`로 재현하고 임의의 sleep에 의존하지 않는다.

- 코드를 탐색할 때는 codegraph 등의 도구를 사용하시오.
- 변형은 리터럴 태그를 가진 서로소 유니온으로 표현하고 `switch`로 분기하시오. `"key" in obj` 식 판별은 쓰지 마시오.
- 확정한 제품과 설계 결정은 [docs/decisions.md](docs/decisions.md)에 날짜와 함께 남기시오.
