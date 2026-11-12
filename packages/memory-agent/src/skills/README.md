# skills

## Overview

`packages/memory-agent/src/skills`는 에이전트 스킬(`SKILL.md` 폴더)을 찾아 읽는 계층이다. `skills.ts`는 앱 내장(builtin), 사용자 전역(`~/.agents/skills`), 프로젝트(`.agents/skills`) 순서로 스킬을 스캔한다. 그 결과로 카탈로그와 본문을 내주는 `Skills` 서비스를 제공한다.

`agent-skills.ts`는 앱이 SQLite에 두는 스킬(`AgentSkills`)을 다룬다. 대화가 저장한 후보는 그 대화의 run만 보고, 검토를 통과한 정식 스킬은 프로젝트의 모든 run이 본다(decisions.md "에이전트가 저장한 스킬은 앱 저장소에 후보로 두고, 검토를 통과한 것만 정식 스킬로 올린다 (2026-11-12)"). `project-skills.ts`의 `ProjectSkills`는 run 하나가 보는 목록을 만든다. builtin·global 스킬, run 폴더에서 git이 커밋한 프로젝트 스킬 폴더(`committed.ts`), 정식 스킬, 그 대화의 후보를 합친다.

`code-skills.ts`는 모델이 저장하는 프로젝트 코드 스킬(`scripts/run.ts` 또는 `scripts/run.sh`)을 다룬다. 범위는 경로, 검증, 첫 줄 마커(input schema, network host), SKILL.md 생성, 실행 명령이다. `CodeSkills` 서비스는 `packages/memory-agent/src/tools/code.ts`와 `packages/memory-agent/src/tools/approved.ts`가 쓴다. 프로그램은 승인된 정확한 내용일 때만 실행된다.

## Interface

- `Skills` — `Context.Service` 태그 "memory-agent/skills/skills". 멤버는 `globalDirectory`, `catalog(project)`, `shared`, `read(project, name)`. `Skills.layer(options)`가 NodeFileSystem과 NodeCrypto 레이어를 붙인다
- `Skills.catalog` — 프로젝트의 `SkillCatalog`(directories는 global/project만, skills, problems)를 돌려준다
- `Skills.shared` — 모든 프로젝트가 가진 builtin·global 스킬(이름이 같으면 global이 이긴다). 앱이 시작할 때 이 스킬들의 작업 규칙 벡터를 미리 만든다(`EmbeddingSetup`)
- `Skills.read` — 이름으로 `SkillDocument`(front matter를 뺀 body, 한 단계 파일 목록)를 돌려준다. 없으면 `null`
- `Skills.catalog` · `Skills.read`의 `committed` — 주면 그 이름의 프로젝트 스킬 폴더만 센다. `ProjectSkills`가 git이 커밋한 폴더만 넘긴다
- `AgentSkills` — `skill_candidates`·`promoted_skills` 표 서비스. `visible(projectId, sessionId?)`는 그 대화의 후보와, 이름이 겹치지 않는 정식 스킬을 이름순으로 돌려준다. `saveCandidate`는 대화의 후보를 같은 이름이면 바꿔 저장한다. `contentSha256(files)`는 경로순으로 놓은 파일의 해시다
- `StoredSkill` — `candidate` | `promoted` TaggedEnum(name, files, contentSha256). `SkillFiles`는 스킬 폴더 안 경로별 텍스트다
- `committedSkillFolders(root)` — `git ls-tree HEAD -- .agents/skills/`로 커밋된 스킬 폴더 이름을 돌려준다. git이 답하지 못하면(git 없음, 저장소 아님, 커밋 없음) `None`이고, 그때는 모든 폴더를 센다
- `ProjectSkills` — `catalog(project, sessionId?)`, `find(project, sessionId, name)`(`FoundSkill` = `stored` | `folder`), `read`, `storedFile`. layer는 `AgentSkills`도 함께 준다
- `SkillsOptions` — 테스트용 `home`과 `builtin` 경로를 덮어쓰는 옵션
- `SkillScope` — `Schema.Literals(["builtin","global","project","promoted","candidate"])`와 같은 이름의 타입. `contracts.ts`에 있고 `skills.ts`가 다시 내보낸다
- `builtinSkillsDirectory` — Effect. `runtimeRoot`가 있으면 그것을, 없으면 `memory-agent/package.json` 위치를 써서 `skills/` 경로를 정한다
- `globalSkillsDirectory(home)` / `projectSkillsDirectory(projectRoot)` — `<base>/.agents/skills` 경로
- `maxSkillCharacters`(32_000자) / `maxSkillBytes`(`maxSkillCharacters * 3`, UTF-8 최대 3바이트/UTF-16 단위) / `maxDescriptionCharacters`(1024) / `maxListedSkills`(100) — 스킬 크기와 목록 한도 상수
- `Skill` / `SkillProblem` / `SkillCatalog` / `SkillDocument` — 스킬 메타(scope, name, description, directory, contentHash), 문제(no_description, too_large, unreadable), 카탈로그와 문서. 앞의 셋은 `contracts.ts`의 Schema 타입이고(앱 API projects group `skills`가 돌려준다), `SkillDocument`는 `skills.ts`의 인터페이스다
- `parseFrontMatter(text)` / `FrontMatter` — SKILL.md front matter의 작은 YAML 부분집합을 `MutableHashMap` 필드와 body로 파싱한다. 지원 형식은 `key: value`, 따옴표 값, `>`, `|`, `>-`, `|-` 블록이다
- `CodeSkills` — 코드 스킬 `Context.Service`이고 `CodeSkills.layer`를 가진다. 구현 `make`는 프로젝트 파일 생성, 읽기, 교체, 삭제와 SKILL.md 생성을 다룬다
- `CodeSkillRejected` — `Schema.TaggedError`. reason은 builtin_overlap, not_code_skill, network_line, input_line, input_schema, not_found, not_approved, ts_skill, absolute_path 중 하나다. 필드는 `detail`이다
- `SkillRuntime` — `"ts" | "sh"`
- `codeSkillDirectory(name)` — 문자열 `.agents/skills/<name>`
- `builtinOverlap(script)` — sh 스크립트의 모든 선두 프로그램이 내장 도구(ls, cat, grep, rm 등)로 대체 가능하면 `Option.some(CodeSkillRejected)`를 돌려준다
- `scriptNetwork(text)` — 첫 줄 `# run_skill network:`에서 `NetworkHost` 스키마를 통과한 호스트 목록을 읽는다
- `InputSchema` — ts 스킬 입력 JSON Schema(`Record<string, unknown>`)의 스키마와 타입
- `inputSignature(schema)` — 입력 스키마를 짧은 TS 비슷한 타입 문자열로 만든다. 스키마가 없으면 "none"이다. 300자를 넘으면 안내 문구로 바꾼다
- `SavedProgram` — 저장된 스킬 프로그램의 현재 상태를 나타내는 `Data.TaggedEnum` 타입과 값. `Option<InputSchema>`를 담는다. `packages/memory-agent/src/tools/approved.ts`와 `packages/memory-agent/src/tools/code.ts`가 쓴다
- `skillCommand` — `Function.dual(3)`. 정확히 그 스크립트 텍스트와 인자를 실행하는 명령줄 문자열을 만든다. `packages/memory-agent/src/tools/approved.ts`가 쓴다

## Invariants

- 스킬 로드 순서는 builtin, global, project, promoted, candidate다. 이름이 같으면 뒤 scope가 이긴다. 앞의 셋은 `Skills.load`의 `MutableHashMap.fromIterable`가, 뒤의 둘은 `AgentSkills.visible`과 `ProjectSkills.load`가 정한다
- run이 보는 프로젝트 스킬 폴더는 run 폴더의 HEAD에 커밋된 것뿐이다. 카드 worktree는 커밋에서 갈라지므로, 사용자 폴더에만 있는 폴더를 계획자가 보고 카드가 못 보는 일이 없다
- builtin 스킬 경로는 이 모듈 위치가 아니라 패키지(`runtimeRoot` 또는 `memory-agent/package.json`)로 찾는다. 앱이 이 모듈을 서버 빌드에 번들하기 때문이다
- SKILL.md가 `maxSkillBytes`를 넘거나 디코드한 텍스트가 `maxSkillCharacters`를 넘으면 `too_large`, description이 비면 `no_description`이 된다. 읽기 실패(PlatformError, PathRejected, TextFileIoFailed, TextFileRejected)는 조용히 버리지 않고 `unreadable` problem으로 남긴다
- 스캔은 `.`으로 시작하는 폴더를 건너뛰고 폴더를 정렬한다. 목록(`readDirectoryEntries`)이 준 항목 자신의 type이 Directory가 아니면 제외하고, type을 모르는 항목만 `lstat`한다. SKILL.md도 `lstat`이 File일 때만 읽으므로 심볼릭 링크는 따라가지 않는다
- 카탈로그와 `read`는 부를 때마다 디스크에서 스킬 폴더를 다시 나열하고 각 SKILL.md를 `lstat`한다. 사람이 스킬을 언제든 바꿀 수 있기 때문이다. 파일 내용은 scope와 경로마다 마지막으로 읽은 결과를 파일 도장(device, inode, 크기, 변경·수정 시각)과 함께 기억하고, 도장이 같으면 다시 읽지 않는다. 읽지 못한 결과(`unreadable`)는 기억하지 않는다. 세 scope를 함께, scope마다 스킬 16개(`readConcurrency`)씩 함께 읽는다. 결과 순서는 폴더 이름 순서 그대로다
- SKILL.md는 발견 뒤 바꿔치기된 링크를 따르지 않도록 같은 leaf를 `readFileBytesEffect`로 연다. 크기는 lstat 때와 읽은 뒤에 두 번 확인한다
- `contentHash`는 발견에 쓴 정확한 SKILL.md 텍스트의 SHA-256 hex다
- description은 `maxDescriptionCharacters`로 자른다. name이 없으면 폴더 이름을 쓴다
- builtin 스킬의 `files`는 항상 빈 배열이다. global과 project 스킬의 files는 SKILL.md와 dotfile을 빼고 정렬한 뒤 최대 100개로 자른다
- 코드 스킬은 표준 스킬 폴더와 같은 파일(`SKILL.md`, `scripts/run.ts` 또는 `scripts/run.sh`)을 가진다. `save_code_skill`은 그 파일을 저장한 대화의 후보로 SQLite에 둔다. 실행은 그 대화의 후보, 정식 스킬, 커밋된 프로젝트 스킬 폴더 순으로 찾는다
- 프로그램은 저장할 때 승인된 정확한 내용일 때만 실행된다
- network 호스트(`# run_skill network:`)와 입력 스키마(`// run_skill input:`)는 스크립트 첫 줄에 쓴다. 승인 텍스트의 일부이므로 코드와 함께 승인, 해시, 표시된다. 이 줄은 `network`/`input` 필드에서만 생성된다. 사용자가 code나 script에 직접 넣으면 `network_line`/`input_line`으로 거부한다
- ts 스킬의 input은 `type: "object"`인 JSON Schema여야 한다. 아니면 `input_schema`로 거부한다
- 저장할 프로그램(sh의 script, ts의 code)이 프로젝트 폴더를 절대 경로로 적어도 거부하지 않는다. 카드 밖에서는 run의 root가 사용자 프로젝트 폴더라 적은 그대로 저장한다. 칸반 카드에서는 카드 worktree를 적은 곳을 사용자 프로젝트 폴더로 바꿔 저장한다(`CodeSkills.rewritten`). 카드 worktree는 merge 뒤 사라지고, 카드에서 sh 스킬을 실행할 때는 사용자 프로젝트 폴더를 다시 카드 worktree로 바꾸며(`tools/approved.ts`, 카드 worktree에 없는 `.env`·`node_modules` 같은 경로는 사용자 폴더 그대로), ts 스킬이 부르는 도구는 경로 정책이 옮기기 때문이다. 찾는 표기는 그대로 적은 경로, 실제 경로, 홈 아래면 `~/…`·`$HOME/…`·`${HOME}/…`이고, 경로 전체이거나 `/`가 이어질 때만이다(`files/path-policy.ts`의 `folderMentions`)
- 이 바꾸기는 승인보다 먼저 한다. `save_code_skill`의 `plan`이 바꾼 프로그램으로 `Rewritten` 호출을 정해, 승인 창과 권한 검토가 저장될 프로그램을 본다. 저장 결과에는 카드에서 사용자 폴더를 적은 프로그램이면 `pathNote`가 붙는다. 사용자 프로젝트 폴더 경로가 프로그램에 그대로 들어갈 수 없으면(`isPlainPath`가 아니면) 예전처럼 `absolute_path`로 거부한다
- sh 스크립트의 모든 단계(`;`, `&&`, `||`로 나뉨)가 내장 도구로 대체 가능한 프로그램으로 시작하면 `builtin_overlap`으로 거부한다. 파이프 뒤 필터는 허용한다. 판정할 때 `command`, `exec`, `env`, `time`, `nice` 접두와 `VAR=` 대입은 건너뛴다. `cd`, `set`, `export`, `true`, `:`, `echo`, `printf`, `exit` 단계는 무시한다

## Side Effects

- `Skills`: FileSystem의 `stat`, `lstat`, `readDirectoryEntries`, `readDirectory`와 `readFileBytesEffect`로 builtin, `~/.agents/skills`, `<project>/.agents/skills`를 읽는다. 쓰기는 하지 않는다
- `Skills`: `Digest.digest(Digest.sha256)`으로 해시를 계산한다. `homeDirectory`, `runtimeRoot`, `runtimeRequire`(require.resolve)로 호스트 경로를 확인한다
- `CodeSkills`: 커밋된 스킬 폴더의 `scripts/run.*`를 `resolveProjectPath`와 `readTextFileEffect`로 읽는다. 저장은 `AgentSkills.saveCandidate`로 한다
- `AgentSkills`: `skill_candidates` INSERT ... ON CONFLICT, `skill_candidates`·`promoted_skills` SELECT
- `committedSkillFolders`: run 폴더에서 `git ls-tree`를 실행한다
- `code-skills.ts`는 `SqlClient`(effect/sql), `Clock`, `DateTime`, `effect/crypto`를 import한다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
