# tools

## Overview

`packages/memory-agent/src/tools`는 에이전트 루프(Effect AI)가 모델에 노출하는 내장 도구의 정의·실행·실패 표현을 모은 디렉터리다. `runTool`/`RunTool`은 도구 정의(스키마·설명·승인 여부·lazy)와 핸들러를 묶는다. `failure.ts`는 모든 실패를 경로·시스템 메시지를 가린 `ToolFailed`로 바꾸고, `schema.ts`는 OpenAI strict 도구용 닫힌 JSON Schema를 만든다.

파일·외부 파일·코드 스킬·셸·백그라운드 작업·메모리·Kagi 검색·위임·리포트 증거 도구는 각각 `Context.Service`(`FileTools`, `ApprovedTools`, `BackgroundTasks` 등)로 제공된다. `definitions.ts`는 브라우저에서도 import 가능한 채팅 UI·서버 공용 계약 모듈이며, 승인 게이트 도구의 서버 구현은 `approved.ts`에 있다.

## Interface

- `runTool` — 이름·설명·파라미터 스키마·핸들러(+선택 `jsonSchema`, `needsApproval`, `lazy`)로 `RunTool`을 만든다. success는 `JsonValue`, failure는 `ToolFailureResult`, `failureMode: "return"`
- `RunTool` / `ToolCall` / `PreparedCall` — 루프가 쓰는 도구 계약: `tool`(Effect AI `Tool.Any`), `lazy`, `prepare(params)`(스키마 디코드 후 실행 가능한 호출 반환)
- `preparedCall` — 임의 실패 가능한 핸들러를 모델이 읽는 JSON 결과·`ToolFailed` 실패로 감싼다(인터럽트는 유지)
- `ToolFailed` — `code`/`tag`/`detail`/선택 `refused: true`를 가진 TaggedError. `message`는 `code: detail` 형식
- `ToolFailureResult` / `failureResult` — 모델에 돌려주는 실패 결과 `{ error, cause, detail }` 스키마와 변환 함수
- `toolFailure` / `toolFailedOf` / `errorTag` / `withDetail` / `SystemError` — 임의 Error를 경로 힌트와 함께 가려진 `ToolFailed`로 바꾸는 유틸리티
- `guardedEffect` / `guardedChange` — SDK 경계에서 실패를 `ToolFailed`(`Cause.UnknownError` 안)로 바꾼다. `guardedChange`는 검사 단계 거부를 `refused: true`로 표시
- `toolParametersJsonSchema` — Effect Schema를 draft-07 닫힌 객체 JSON Schema로 바꾸고 bound/annotation만 가진 `allOf`를 노드에 접는다
- `builtinToolEffects` / `readOnlyToolNames` — 내장 도구별 `read`/`effectful` 명시 계약과 읽기 전용 도구 이름 집합(은퇴 도구 포함)
- `gatedToolNames` — 어떤 권한 모드에서도 승인 없이 실행되지 않는 도구(`save_code_skill`, `write_outside_file`, `delete_outside_file`)
- `saveCodeSkillSpec` / `writeOutsideFileSpec` / `deleteOutsideFileSpec` — 게이트 도구의 이름·설명·파라미터 스펙
- `SaveCodeSkillInput` / `RunSkillInput` / `WriteOutsideFileInput` / `DeleteOutsideFileInput` / `TsSkillProgram` / `ShSkillProgram` / `NetworkHost` — 코드 스킬·외부 파일 도구 입력 스키마
- `PermissionReviewPayload` / `PermissionReviewResponse` — 권한 검토 요청(`askedBy: review | every_call`)과 응답 계약
- `definitions.ts` 재수출 묶음 — run-state, report(diagnosis/bundle/delivery), uncertain-runs, lease, shown-failure, subagent, loop-health, provider-retry, approvals, queue, improve 계약을 채팅 UI와 공유
- `ApprovedTools` — 코드 스킬 저장·`run_skill`(sh 스킬 샌드박스 실행)·외부 파일 쓰기/삭제를 제공하는 서비스(`ApprovedTools.layer`)
- `resolveShellWorkingDirectory` — 셸 작업 디렉터리 해석: 상대 경로는 프로젝트 내부, 절대 경로는 `/tmp` 또는 호스트 임시 디렉터리 하위만 허용
- `BackgroundTasks` / `BackgroundBinding` / `BackgroundOutcome` / `BackgroundOperationFailed` / `BackgroundResultStoreFailed` / `BackgroundTraceFailed` / `BackgroundTaskNotFound` — 백그라운드 작업 시작·결과 대기 서비스와 그 바인딩(`sessionId`, `runId`, `abortSignal`)·결과·오류
- `FileTools` / `fileToolNames` / `listPageSize` — 프로젝트 파일 도구 서비스(`SecretRedactor.layer` 제공), 목록 페이지 크기 500
- `OutsideTools` / `outsideReadToolNames` — 프로젝트 밖 파일 읽기 전용 도구(자격 증명 제외)
- `CodeTools` — 모델이 쓴 프로그램이 run의 도구를 코드 샌드박스에서 호출하게 하는 서비스(`CodeSandbox.layer` 제공)
- `MemoryTools` / `memoryRunTools` / `memoryReadRunTools` / `memoryToolNames` / `PromotedMemoryUseRejected` / `MemoryToolEnvironment` / `MemoryToolRunBinding` / `MemoryToolScope` — 메모리 도구와 run 단위 검색·사용 귀속 기록
- `KagiTools` / `kagiToolNames` / `kagiInstructions` / `maxPageCharacters` — Kagi 웹 검색(`kagi_search`, `kagi_extract`), 페이지 최대 40,000자
- `DelegateTools` / `delegateToolName` / `delegateInstructions` / `DelegateToolset` / `DelegateBinding` 및 `SkillTools` / `skillsInstructions` / `SkillToolset` — 다른 에이전트 위임(`delegate_to_agent`)과 스킬 도구
- `lazyToolsFor` / `discoveryToolName` / `isDiscoveryCall` / `ToolLookup` 및 `repeatGuardHook` / `RepeatedToolCall` / `repeatedToolCallCode` — history 기반 lazy 도구 발견, 같은 호출 반복을 막는 `RunHook`
- `reportRunToolsForSession` / `reportBinding` / `initialReportEvidence` / `ReportBinding` 및 `prepareRepaired` / `repairedInput` / `jsonSchemaIssues` — 리포트 세션 증거 도구, 보낸 인수가 안 맞으면 수리된 인수로 호출을 준비하는 입력 수리
- 하위 디렉터리 없음

## Invariants

- 새 내장 도구를 추가하면 `builtinToolEffects`에 `read`/`effectful`을 명시해야 한다. 소스 등록 커버리지 테스트가 이를 요구하고, 계약을 바꿀 때는 구현을 확인해야 한다. 알 수 없는/커스텀/MCP 도구는 effectful로 취급된다.
- 대체된 도구 이름(`get_subagent_report`, `save_shell_skill`, `wait_subagents`)은 기록된 run·history에 남아 있으므로 `retiredToolEffects`에서 지우면 안 된다.
- `definitions.ts`는 브라우저에서 import해도 안전해야 한다. 서버 구현은 `approved.ts`에 둔다.
- `gatedToolNames`의 도구는 어떤 권한 모드에서도 승인 없이 실행되지 않는다. `run_skill`은 호출마다 게이트하지 않고, 저장 시 승인된 프로그램만 실행한다(수정되었거나 승인 안 된 스킬은 다시 저장할 때까지 거부).
- 루프는 게이트보다 먼저 인수를 디코드한다. 스키마에 맞지 않는 호출은 게이트에 닿지 않는다. 호출 준비는 `prepareRepaired`를 거쳐 TanStack이 수리한 인수도 받는다.
- 인터럽트(취소)된 호출은 `ToolFailed`로 바꾸지 않고 인터럽트로 유지한다. Error가 아닌 throw 값은 모델에 아무것도 보이지 않도록 `new Error("unknown")`로 바꾼다.
- 모델이 보는 실패에는 호스트 오류의 code만 남긴다. 절대 경로와 시스템 메시지가 대화로 새면 안 된다. `ToolFailed` 메시지는 `code: detail` 형식을 유지한다.
- `guardedEffect`/`guardedChange`는 `ToolFailed`를 `Cause.UnknownError`에 넣어 넘기고, `run-tool.ts`의 `failedCall`이 이를 풀어낸다. 이 짝을 함께 유지해야 한다.
- `guardedChange`는 파일 쓰기가 파일 연산뿐인 변경에만 쓴다. 실패가 `TextFileIoFailed`가 아니고 defect도 없을 때만 `refused: true`(아무것도 바뀌지 않음)로 표시한다.
- `toolParametersJsonSchema`는 OpenAI strict 도구 조건에 맞게 닫힌 객체(`onExcessProperty: "error"`)를 내보내고 `allOf`를 접는다. 접히지 않은 bound는 도구를 non-strict로 만든다. `const`/`enum`/`default`/`examples` 값은 정규화하지 않는다. 디코드는 모델에 없는 속성을 거부하지 않고 버린다.
- `PermissionReviewPayload.askedBy`는 이 필드가 생기기 전에 저장된 요청과 호환되도록 optional이다(없으면 review로 간주).
- ts 스킬은 `CodeTools`가 실행한다. 프로그램에서 `ApprovedTools.runSkill`로 ts 스킬에 닿으면 `CodeSkillRejected(reason: "ts_skill")`로 거부한다.
- OS 샌드박스가 없을 때(`SandboxUnavailable`) 샌드박스 없이 실행하는 것은 `permissionMode === "full"`에서만 허용한다.
- `run_skill` 타임아웃은 `[1, maxTimeoutSeconds]`로 고정되고 기본값은 `defaultTimeoutSeconds`다. `yieldMs` 기본값은 1000, 범위는 0~30000이다.
- `write_outside_file`은 `expectedSha256`가 없으면 새 파일만 만들고, 있으면 기존 파일이 있어야 한다(없으면 `not_found`). 외부 경로는 `project.toolFence`로 제한된다.
- 백그라운드 셸 결과: `failed`이면 `ProcessExited`, `timed_out`이면 `ProcessTimedOut`, `succeeded`/`cancelled`이면 실패 이유가 없다. 비정상 종료여도 출력은 보관한다.
- `reportRunToolsForSession`의 trace 콜백은 소스 세션으로 이미 범위가 정해져 있어야 한다. 세션 id를 콜백에 넘기지 않는다.

## Side Effects

- 자식 프로세스: `ApprovedTools.runSkill`이 `runSandboxed`/`runCommand`로 sh 스킬을 실행하고 `process.env`를 그대로 넘긴다(`ChildProcessSpawner`).
- 파일 시스템: `write_outside_file`/`delete_outside_file`이 프로젝트 밖 텍스트 파일을 생성·교체·삭제한다(`createTextFileEffect`, `replaceTextFileEffect`, `deleteTextFileEffect`). 작업 디렉터리 해석 때 `/tmp`와 호스트 임시 디렉터리의 canonical 경로를 읽는다.
- 파일 시스템: `save_code_skill`이 `CodeSkills.save`로 `.agents/skills/<name>/`(SKILL.md, scripts/run.ts 또는 run.sh)에 스킬을 저장한다.
- 프로젝트 파일 도구(`FileTools`)가 `write_file`/`edit_file`/`delete_file`로 프로젝트 파일을 바꾼다. 목록·검색은 파일 시스템 페이징/스냅샷 캐시만 쓴다(`effects.ts` 주석 근거).
- 백그라운드 작업: `BackgroundTasks.start`/`waitResult`가 세션 단위 백그라운드 작업을 시작하고 결과를 기다린다. 결과 저장소·trace 실패 오류 타입이 따로 있다.
- 영속 기록: `find_memory`는 승격된 매치를 가져올 때 `memory_usage_events`를 기록한다. `memoryRunTools`는 run 단위 검색·사용 귀속을 영속 기록한다. 리포트 증거 도구는 범위가 정해진 SELECT만 한다(`effects.ts` 주석 근거).
- 네트워크: `kagi_search`/`kagi_extract`가 원격 Kagi API를 호출한다. 응답이 실패해도 요금이 나올 수 있다(`effects.ts` 주석 근거).
- 상태: `repeatGuardHook`이 반복 호출 감지 상태를 `Ref`로 보관한다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
