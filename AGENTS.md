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

- 코드를 탐색할 때는 codegraph 등의 도구를 사용하시오.
- 변형은 리터럴 태그를 가진 서로소 유니온으로 표현하고 `switch`로 분기하시오. `"key" in obj` 식 판별은 쓰지 마시오.
- 확정한 제품과 설계 결정은 [docs/decisions.md](docs/decisions.md)에 날짜와 함께 남기시오.
