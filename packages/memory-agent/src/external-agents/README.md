# external-agents

## Overview

`external-agents`는 앱이 ACP(Agent Client Protocol) 클라이언트로서 Codex 같은 외부 에이전트 프로세스를 띄우고, stdin/stdout으로 대화하게 하는 모듈이다(R17).
`config.ts`는 전역(`<storageRoot>/agents.json`)과 프로젝트(`<projectRoot>/.agents/agents.json`) 설정 파일을 읽고 검증한다. 또 신뢰 판단에 쓰는 명령 fingerprint를 만든다.
`agents.ts`는 연결 상태(링크), 신뢰 상태, 프롬프트 결과 타입, 권한 응답, Windows 실행 파일 해석을 정의한다. 이것들은 `ExternalAgents` Effect 서비스로 묶인다.

## Interface

- `ExternalAgents` — 외부 ACP 에이전트를 다루는 Context 서비스 클래스(`agents.ts`). 형태는 `make`가 정하고 `ExternalAgents.layer`를 제공함
- `agentCommandInvocation` — `Effect.fn("ExternalAgent.commandInvocation")`. win32가 아니면 command/args를 그대로 돌려줌. win32면 PATHEXT/PATH, shebang, cross-spawn과 같은 cmd 이스케이프 규칙으로 실행 파일을 해석함(FileSystem, Path 필요)
- `maxConsecutiveFailures` — 연속 연결 실패 한도(2). 한도에 닿으면 재연결은 사용자의 수동 조작을 기다림
- `ExternalAgentInitializeTimedOut` — 프로세스가 시간 안에 `initialize`에 답하지 않을 때 나는 `Schema.TaggedError`
- `AgentLinkState` — 링크 상태 TaggedEnum: idle / connecting{failures} / connected{agent, loadSession} / retrying{failures, failure} / stopped{failures, failure}. 타입은 `contracts.ts`에서 오고, `agents.ts`가 `Data.taggedEnum` 생성자를 둔다
- `AgentTrustState` — 신뢰 상태 TaggedEnum: untrusted / changed / trusted{link}. 타입과 생성자는 `AgentLinkState`와 같은 방식이다
- `ExternalAgentView` — 설정 화면용 에이전트 뷰(scope, name, 비밀을 가린 target, envNames, shadowed, state). `contracts.ts`의 Schema
- `ExternalAgentsOverview` — 설정 파일별 경로·오류 목록과 에이전트 뷰 목록. `contracts.ts`의 Schema이고 앱 API projects group(`agents`/`agentAction`)이 돌려준다
- `ExternalPromptOutcome` — 프롬프트 결과 TaggedEnum: completed / cancelled / disconnected / failed / unavailable
- `ReportedToolCall` — 외부 에이전트가 보고한 도구 호출(title, kind, status)
- `PromptHooks` — 호출자 훅: `onUpdate`(모든 SessionUpdate), `askPermission(request, signal)`(`Effect<boolean>`, 명시적 승인일 때만 true)
- `AgentScope` — `"global" | "project"` `Schema.Literals` (`contracts.ts`). `contracts.ts`는 서버 코드를 import하지 않아 브라우저 번들이 쓴다
- `AgentCommand` — `{ command: NonEmptyString, args: string[] = [], env: Record<string,string> = {} }` 스키마 (`config.ts`)
- `ConfiguredAgent` — scope, name, command, fingerprint를 가진 읽힌 에이전트 (`config.ts`)
- `AgentsFileRead` — 파일 하나를 읽은 결과(path, agents, `ShownFailure<ConfigFileFailureCode>|null` error) (`config.ts`)
- `globalAgentsFile` / `projectAgentsFile` — `join(storageRoot, "agents.json")` / `join(projectRoot, ".agents", "agents.json")` 경로 함수 (`config.ts`)
- `agentFingerprint` — `[command, args, 키로 정렬한 env 항목]` JSON의 sha256 (`config.ts`)
- `readAgentsFile` — dual `(path, scope)` 또는 `(scope)(path)`. 실패하지 않는 Effect로 `AgentsFileRead`를 돌려줌(FileSystem 필요, span `agents.readConfig`) (`config.ts`)
- 하위 디렉터리 없음

## Invariants

- `agents.json`의 에이전트 이름은 `McpServerName` 스키마를 통과해야 함. 통과하지 못한 이름은 목록에서 빠지고, `invalid_names` 오류에 쉼표로 나열됨
- `readAgentsFile`은 실패하지 않음. 존재 확인이 PlatformError로 실패한 파일은 없는 파일로 취급함(error null). 읽기 실패는 `unreadable`(detail null). 디코드 실패는 `invalid_config`(오류 문자열 앞 4줄)
- fingerprint는 사용자가 신뢰한 정확한 command·args·env의 해시임. env는 키 순서로 정렬해 해시하므로 키 순서는 결과에 영향이 없음. 값이 바뀌면 fingerprint가 바뀜(신뢰 상태 `changed`의 근거)
- `AgentsFileRead.error.detail`과 connectFailure의 detail은 비밀을 가리지 않은 값임. 보여 주기 전에 소유자(SecretRedactor 사용 측)가 가려야 함
- 권한 요청 응답은 `allow_once`나 `reject_once`만 고름. 상시 허용("always")은 절대 고르지 않음. 원하는 옵션이 없으면 `cancelled`
- LinkState는 SynchronizedRef 잠금 아래에서 통째로 교체함. 진행 중인 연결 시도(`attempt` Fiber)는 그동안 호출자들이 공유함
- `Live.sessions`의 앱 세션 키와 에이전트 세션 id 대응은 해당 프로세스에서만 유효함
- 연속 실패가 `maxConsecutiveFailures`(2)에 닿으면 상태는 `stopped`이고, 수동 재연결만 다시 시도함. `retrying`이면 다음 사용이나 자동 재연결이 다시 시도함
- 연결이 답변 도중 끊기면(`disconnected`) 받은 내용은 유지하고 프롬프트를 다시 보내지 않음
- 연결 실패 코드 매핑: MissingVariable→`missing_env`, 초기화 시간 초과→`initialize_timed_out`, PlatformError→`spawn_failed`, acp.RequestError→`agent_error`(`data.message` 덧붙임), 그 밖→`connection_failed`
- 초기화 시간 제한은 30_000ms(`connectTimeoutMs`), 재시도 지연은 100ms(`retryDelayMs`)

## Side Effects

- 파일 시스템: `fs.exists`와 `fs.readFileString`으로 전역·프로젝트 `agents.json`을 읽음 (`config.ts`)
- 자식 프로세스: 설정된 ACP 에이전트 명령을 띄우고 stdin/stdout으로 통신함(`ChildProcessSpawner`, `SdkStreams`). `Live.dispose`가 프로세스와 스트림을 끝냄
- Windows 실행 파일 해석: `PATHEXT`·`Path`/`PATH` 환경 변수와 `process.platform`을 읽음. cwd와 PATH 디렉터리에서 파일 존재를 확인하고 shebang 첫 줄을 읽음 (`agentCommandInvocation`)
- 환경 변수: `getDefaultEnvironment`(MCP stdio)를 쓰고 `expandVariablesResult`로 설정 env의 변수를 확장함. 변수가 없으면 MissingVariable
- SQLite: `SqlClient`/`SqlSchema`와 `TrustRow`(scope, name, fingerprint) 스키마로 신뢰 기록을 다룸
- Fiber·타이머: 연결 시도를 Fiber로 공유하고(FiberMap, SynchronizedRef, Ref), 30초 초기화 시간 제한과 100ms 재시도 지연을 둠. 시각은 Clock/DateTime으로 읽음

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
