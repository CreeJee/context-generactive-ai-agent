# skills

## Overview

`packages/memory-agent/src/skills`는 에이전트 스킬(`SKILL.md` 폴더)을 찾아 읽는 계층이다. `skills.ts`는 앱 내장(builtin), 사용자 전역(`~/.agents/skills`), 프로젝트(`.agents/skills`) 순서로 스킬을 스캔한다. 그 결과로 카탈로그와 본문을 내주는 `Skills` 서비스를 제공한다.

`code-skills.ts`는 모델이 저장하는 프로젝트 코드 스킬(`scripts/run.ts` 또는 `scripts/run.sh`)을 다룬다. 범위는 경로, 검증, 첫 줄 마커(input schema, network host), SKILL.md 생성, 실행 명령이다. `CodeSkills` 서비스는 `packages/memory-agent/src/tools/code.ts`와 `packages/memory-agent/src/tools/approved.ts`가 쓴다. 프로그램은 승인된 정확한 내용일 때만 실행된다.

## Interface

- `Skills` — `Context.Service` 태그 "memory-agent/skills/skills". 멤버는 `globalDirectory`, `catalog(project)`, `read(project, name)`. `Skills.layer(options)`가 NodeFileSystem과 NodeCrypto 레이어를 붙인다
- `Skills.catalog` — 프로젝트의 `SkillCatalog`(directories는 global/project만, skills, problems)를 돌려준다
- `Skills.read` — 이름으로 `SkillDocument`(front matter를 뺀 body, 한 단계 파일 목록)를 돌려준다. 없으면 `null`
- `SkillsOptions` — 테스트용 `home`과 `builtin` 경로를 덮어쓰는 옵션
- `SkillScope` — `Schema.Literals(["builtin","global","project"])`와 같은 이름의 타입
- `builtinSkillsDirectory` — Effect. `runtimeRoot`가 있으면 그것을, 없으면 `memory-agent/package.json` 위치를 써서 `skills/` 경로를 정한다
- `globalSkillsDirectory(home)` / `projectSkillsDirectory(projectRoot)` — `<base>/.agents/skills` 경로
- `maxSkillCharacters`(32_000자) / `maxSkillBytes`(`maxSkillCharacters * 3`, UTF-8 최대 3바이트/UTF-16 단위) / `maxDescriptionCharacters`(1024) / `maxListedSkills`(100) — 스킬 크기와 목록 한도 상수
- `Skill` / `SkillProblem` / `SkillCatalog` / `SkillDocument` — 스킬 메타(scope, name, description, directory, contentHash), 문제(no_description, too_large, unreadable), 카탈로그와 문서 인터페이스
- `parseFrontMatter(text)` / `FrontMatter` — SKILL.md front matter의 작은 YAML 부분집합을 `MutableHashMap` 필드와 body로 파싱한다. 지원 형식은 `key: value`, 따옴표 값, `>`, `|`, `>-`, `|-` 블록이다
- `CodeSkills` — 코드 스킬 `Context.Service`이고 `CodeSkills.layer`를 가진다. 구현 `make`는 프로젝트 파일 생성, 읽기, 교체, 삭제와 SKILL.md 생성을 다룬다
- `CodeSkillRejected` — `Schema.TaggedError`. reason은 builtin_overlap, not_code_skill, network_line, input_line, input_schema, not_found, not_approved, ts_skill 중 하나다. 필드는 `detail`이다
- `SkillRuntime` — `"ts" | "sh"`
- `codeSkillDirectory(name)` — 문자열 `.agents/skills/<name>`
- `builtinOverlap(script)` — sh 스크립트의 모든 선두 프로그램이 내장 도구(ls, cat, grep, rm 등)로 대체 가능하면 `Option.some(CodeSkillRejected)`를 돌려준다
- `scriptNetwork(text)` — 첫 줄 `# run_skill network:`에서 `NetworkHost` 스키마를 통과한 호스트 목록을 읽는다
- `InputSchema` — ts 스킬 입력 JSON Schema(`Record<string, unknown>`)의 스키마와 타입
- `inputSignature(schema)` — 입력 스키마를 짧은 TS 비슷한 타입 문자열로 만든다. 스키마가 없으면 "none"이다. 300자를 넘으면 안내 문구로 바꾼다
- `SavedProgram` — 저장된 스킬 프로그램의 현재 상태를 나타내는 `Data.TaggedEnum` 타입과 값. `Option<InputSchema>`를 담는다. `packages/memory-agent/src/tools/approved.ts`와 `packages/memory-agent/src/tools/code.ts`가 쓴다
- `skillCommand` — `Function.dual(3)`. 정확히 그 스크립트 텍스트와 인자를 실행하는 명령줄 문자열을 만든다. `packages/memory-agent/src/tools/approved.ts`가 쓴다

## Invariants

- 스킬 로드 순서는 builtin, global, project다. 이름이 같으면 뒤 scope가 이긴다. 이 순서는 `Skills.load`의 `MutableHashMap.fromIterable`가 정한다
- builtin 스킬 경로는 이 모듈 위치가 아니라 패키지(`runtimeRoot` 또는 `memory-agent/package.json`)로 찾는다. 앱이 이 모듈을 서버 빌드에 번들하기 때문이다
- SKILL.md가 `maxSkillBytes`를 넘거나 디코드한 텍스트가 `maxSkillCharacters`를 넘으면 `too_large`, description이 비면 `no_description`이 된다. 읽기 실패(PlatformError, PathRejected, TextFileIoFailed, TextFileRejected)는 조용히 버리지 않고 `unreadable` problem으로 남긴다
- 스캔은 `.`으로 시작하는 폴더를 건너뛰고 폴더를 정렬한다. `lstat` 기준 Directory가 아닌 항목은 제외한다. SKILL.md도 `lstat`이 File일 때만 읽으므로 심볼릭 링크는 따라가지 않는다
- SKILL.md는 발견 뒤 바꿔치기된 링크를 따르지 않도록 같은 leaf를 `readFileBytesEffect`로 연다. 크기는 lstat 때와 읽은 뒤에 두 번 확인한다
- `contentHash`는 발견에 쓴 정확한 SKILL.md 텍스트의 SHA-256 hex다
- description은 `maxDescriptionCharacters`로 자른다. name이 없으면 폴더 이름을 쓴다
- builtin 스킬의 `files`는 항상 빈 배열이다. global과 project 스킬의 files는 SKILL.md와 dotfile을 빼고 정렬한 뒤 최대 100개로 자른다
- 코드 스킬은 표준 스킬 폴더 `.agents/skills/<name>/SKILL.md`와 `scripts/run.ts` 또는 `scripts/run.sh`를 쓴다. 그래서 다른 에이전트도 목록에서 보고 읽고 쓸 수 있다
- 프로그램은 저장할 때 승인된 정확한 내용일 때만 실행된다
- network 호스트(`# run_skill network:`)와 입력 스키마(`// run_skill input:`)는 스크립트 첫 줄에 쓴다. 승인 텍스트의 일부이므로 코드와 함께 승인, 해시, 표시된다. 이 줄은 `network`/`input` 필드에서만 생성된다. 사용자가 code나 script에 직접 넣으면 `network_line`/`input_line`으로 거부한다
- ts 스킬의 input은 `type: "object"`인 JSON Schema여야 한다. 아니면 `input_schema`로 거부한다
- sh 스크립트의 모든 단계(`;`, `&&`, `||`로 나뉨)가 내장 도구로 대체 가능한 프로그램으로 시작하면 `builtin_overlap`으로 거부한다. 파이프 뒤 필터는 허용한다. 판정할 때 `command`, `exec`, `env`, `time`, `nice` 접두와 `VAR=` 대입은 건너뛴다. `cd`, `set`, `export`, `true`, `:`, `echo`, `printf`, `exit` 단계는 무시한다

## Side Effects

- `Skills`: FileSystem의 `exists`, `stat`, `lstat`, `readDirectory`와 `readFileBytesEffect`로 builtin, `~/.agents/skills`, `<project>/.agents/skills`를 읽는다. 쓰기는 하지 않는다
- `Skills`: `Crypto.digest("SHA-256")`으로 해시를 계산한다. `homeDirectory`, `runtimeRoot`, `runtimeRequire`(require.resolve)로 호스트 경로를 확인한다
- `CodeSkills`: `resolveProjectPath`를 거쳐 프로젝트 안 `.agents/skills/<name>/` 아래 SKILL.md와 `scripts/run.*`에 `createTextFileEffect`, `readTextFileEffect`, `replaceTextFileEffect`, `deleteTextFileEffect`를 실행한다(생성, 읽기, 교체, 삭제)
- `code-skills.ts`는 `SqlClient`(effect/sql), `Clock`, `DateTime`, `Crypto`를 import한다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
