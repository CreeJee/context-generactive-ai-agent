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
- tools에는 개발 도구를 둔다.
- lint에는 이 저장소의 커스텀 린트 규칙(anti-slop Oxlint 플러그인)을 둔다. 가져온 코드라 lint·fmt 대상에서 빠진다.
- 래포지토리에서는 typescript 를 무조건 사용해야한다.

## common Rules

- 테스트를 추가할때 명확히 필요한 부분만 테스트를 만들것
- 하위호환성의 기준점은 github 릴리즈 기준으로만 잡기
- 확정한 제품과 설계 결정은 [docs/decisions.md](docs/decisions.md)에 날짜와 함께 남기시오.
- 타입으로 확인되지않는 테스트만 만들어야하며, 타입으로 확인이 되는경우 과감히 지워야함

## ttsc-graph와 CodeGraph로 코드 탐색하기

두 MCP를 함께 쓴다. 코드의 위치·구조·호출 관계를 찾거나 고칠 코드를 읽을 때는 텍스트 검색(`search_files`, `rg`, `grep`, `find`)이나 파일 직접 읽기(`read_file`)보다 이 둘을 먼저 사용하시오. 이 앱(context-agent)에서는 `mcp_codegraph__codegraph_explore`라는 이름으로 보인다.

- 저장소 루트에 `.codegraph/`가 있으면 CodeGraph의 `codegraph_explore`를 사용하시오. `query`에는 질문, 심볼 이름 또는 파일 경로를 넣으시오. 예: `codegraph_explore({ query: "workspaceInstructions" })`, `codegraph_explore({ query: "packages/memory-agent/src/agent/project-instructions.ts" })`. 다른 저장소를 탐색할 때는 `projectPath`에 그 저장소의 절대 경로를 지정하시오.
- 질의 요령:
  - 질의에는 심볼 이름이나 파일 경로를 넣으시오. `server`, `runtime`, `instructions`처럼 여러 파일에 흔한 낱말은 관계없는 파일을 끌어오므로 빼시오.
  - 도구 이름(`run_skill`), API 경로, SQL 컬럼처럼 코드에 문자열로만 나오는 이름에서 시작할 때는 텍스트 검색으로 그 문자열을 다루는 심볼(예: `run_skill` → `runSkill`)을 먼저 찾고, 그 심볼로 그래프에 질의하시오.
  - 결과에 찾던 심볼이 없으면 텍스트 검색으로 넘어가기 전에, 결과에 나온 이름으로 좁혀 한 번 더 질의하시오.
  - `run_code`로 호출을 묶을 때도 도구는 같은 기준으로 고르시오. 묶는다는 이유로 그래프 질의를 텍스트 검색으로 바꾸지 마시오.
- 받은 소스·노드·엣지·시그니처를 확인하려고 같은 파일을 다시 읽거나 텍스트 검색하지 마시오. 필요한 내용이 빠졌으면 더 구체적인 심볼이나 파일 경로로 다시 질의하시오.
- 문서·설정·일반 텍스트처럼 TypeScript 밖의 내용, 정확한 문자열 검색, CodeGraph가 재색인 대기 경고를 표시한 파일은 직접 읽거나 `search_files`·`rg`로 찾으시오.

## Effect 지침

이 패키지의 에이전트 백엔드 구현·수리·리팩터링에 Effect다운 설계와 코드 스타일을 적용한다.
아래 의존성 문서 읽기 지침은 이 패키지에서 Effect 코드를 작성하거나 변경할 때 적용한다.

Effect 가이드문서: 설치된 `node_modules/effect/AGENTS.md` or https://raw.githubusercontent.com/Effect-TS/effect/refs/heads/main/.agents/AGENTS.md

## Info

- ~/.context-generactive-agent/agent.db 가 sqlite 파일 db위치입니다
