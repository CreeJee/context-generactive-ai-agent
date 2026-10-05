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

- 변형은 리터럴 태그를 가진 서로소 유니온으로 표현하고 `switch`로 분기하시오. `"key" in obj` 식 판별은 쓰지 마시오.
- 확정한 제품과 설계 결정은 [docs/decisions.md](docs/decisions.md)에 날짜와 함께 남기시오.

## CodeGraph로 코드 탐색하기

- 저장소 루트에 `.codegraph/`가 있으면 코드의 위치·구조·호출 관계를 찾거나 수정할 코드를 읽을 때 `grep`, `rg`, `find`, 파일 직접 읽기보다 CodeGraph를 먼저 사용하시오. 셸을 사용할 수 있어도 이 순서를 지키시오.
- MCP 도구가 있으면 `codegraph_explore`를 호출하시오. `query`에는 질문, 심볼 이름 또는 파일 경로를 넣으시오. 예: `codegraph_explore({ query: "workspaceInstructions" })`, `codegraph_explore({ query: "packages/memory-agent/src/agent/project-instructions.ts" })`. 다른 저장소를 탐색할 때는 `projectPath`에 그 저장소의 절대 경로를 지정하시오.
- 결과의 줄 번호가 있는 소스와 호출 관계를 탐색 근거로 사용하시오. 필요한 코드가 빠졌으면 더 구체적인 심볼이나 파일 경로로 다시 질의하시오. 이미 반환된 코드를 확인하기 위해 같은 파일을 다시 읽거나 grep하지 마시오.
- CodeGraph가 다루지 않는 문서·설정·일반 텍스트, 결과에서 빠진 특정 내용, 재색인 대기 경고가 표시된 파일은 직접 읽거나 검색할 수 있다. `.codegraph/`가 없거나 CodeGraph 호출이 실패하면 일반 파일 도구와 `rg`를 사용하고 그 이유를 밝히시오. 인덱스를 임의로 생성하지 마시오.
- 동기화가 안되어있으면 `codegraph init` 를 실행해줘
