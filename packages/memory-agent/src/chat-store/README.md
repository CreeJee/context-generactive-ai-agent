# chat-store

## Overview

`chat-store`는 앱이 SQLite에 저장하는 채팅 행(`chat_threads.messages`, `chat_history_groups.messages`, `chat_runs.status`/`usage`, `chat_interrupts.payload`/`response`)의 Effect `Schema` 모양과 `chat_metadata` 접근 인터페이스를 정의한다. `tanstack-migration.ts`는 Effect AI 전환(`docs/effect-ai-migration.md` 1단계)을 위한 일회성 마이그레이션이다. TanStack이 쓴 행에서 `metadata.tanstack` 등을 걷어내고 `schema.ts` 모양으로 옮긴다. 이 마이그레이션은 `packages/memory-agent/src/db/database.ts`의 `migrateInTransaction`과 `tools/chat-store-check/main.ts`에서 호출된다.

## Interface

- `StoredMessage` — `chat_threads.messages`·`chat_history_groups.messages`의 메시지 하나. user/assistant/tool 메시지의 `role` 판별 유니온(Schema와 타입)
- `StoredUserMessage` / `StoredAssistantMessage` / `StoredToolMessage` — 역할별 메시지 Schema. assistant에는 `toolCalls`, `thinking`, `model`, `source`, `finishReason`, `stopReason`이 선택 키로 있다
- `TextPart` / `ImagePart` — 메시지 content 배열의 텍스트·이미지(`data`/`url` source) 파트 Schema
- `StoredToolCall` — `type: "function"` 도구 호출 Schema. `function.arguments`는 파싱되지 않을 수도 있는 JSON 텍스트
- `MessageSource` — assistant 메시지를 쓴 호출의 provider·api(선택)·model Schema
- `StoredHistoryGroup` — `chat_history_groups.messages`. 화면 메시지 하나가 보여 주는 스레드 메시지들의 `NonEmptyArray`
- `StoredRunStatus` — `chat_runs.status` 리터럴(`running`, `interrupted`, `completed`, `failed`, `aborted`). 페이지 응답도 쓰므로 `agent/run-state.ts`의 `RunStatus`를 그대로 쓴다
- `StoredUsage` — `chat_runs.usage`. AG-UI 1.0 `TokenUsage` 모양의 음이 아닌 정수 토큰 카운트 Schema와 타입
- `StoredInterruptPayload` — `chat_interrupts.payload`. `reason`(`tool_call` | `permission_review`)으로 판별하는 AG-UI 1.0 `Interrupt` Schema와 타입
- `StoredInterruptResponse` — `chat_interrupts.response`. `approved: true`(선택 `editedArgs`) 또는 `approved: false` 유니온
- `ChatMetadataFailed` — chat metadata 읽기·쓰기 실패 `Schema.TaggedError`(`cause`는 Defect)
- `ChatMetadata` — `get(namespace, key)`/`set(namespace, key, value: JsonValue)` 인터페이스. `get`은 디코딩하지 않은 `unknown`을 돌려주고, 없으면 absent. `RunStore`가 이 행을 보관
- `migrateMessage` — 메시지의 `metadata.tanstack` 중 `createdAt`·`model`·`source`·`finishReason`·`stopReason`을 최상위로 올리고 TanStack 키와 toolCall metadata를 제거하는 순수 변환
- `migrateUsage` — TanStack `TokenUsage`를 AG-UI 1.0 usage로 바꾸는 dual 함수. `inputExcludesCache`면 캐시 읽기·쓰기를 입력에 더하고 total을 다시 계산
- `migrateInterruptPayload` — interrupt payload의 `tanstack:interruptPayload`를 `metadata.payload`로 옮기고 `tanstack:interruptBinding`을 제거
- `migrateTanStackRows` — `Effect.fn("ChatStore.migrateTanStackRows")`. `SqlClient`가 필요하며 threads, BTW threads, history groups, handoff, interrupts, usage 행을 모두 마이그레이션

## Invariants

- `tanstack-migration.ts`의 각 변환은 멱등이어야 한다. 이미 마이그레이션된 행은 바뀌지 않고 그대로 통과해야 한다.
- `migrateMessage`는 메시지에 같은 최상위 필드가 이미 있으면 `metadata.tanstack`의 값으로 덮어쓰지 않는다(`!Object.hasOwn(message, field)`).
- `metadata`에서 TanStack 키(`tanstack`, `tanstack:*`)를 빼고 남는 것이 없으면 `metadata` 키 자체를 지운다.
- `rewrite`는 인코딩한 JSON 텍스트가 원래 값과 다를 때만 쓴다. 레이아웃만 다른 행은 원래 텍스트를 유지한다.
- 저장소가 JSON 값으로 쓴 텍스트이므로 `decodeJson`/`decodeMessages` 실패는 `Effect.orDie` 결함으로 취급한다.
- handoff anchor는 경계 메시지의 fingerprint다. 마이그레이션이 그 메시지를 바꾸므로 anchor를 다시 계산해야 한다. legacy anchor는 `modelHandoffHistoryEffect`처럼 v2(`through`, 선택 `anchorId`)로 옮긴다. 경계가 더는 맞지 않으면 그대로 둔다.
- usage의 `inputExcludesCache`는 anthropic provider의 run이면서 `promptTokensDetails.cacheWriteTokens`가 없을 때만 참이다. 근거는 456191fe 이전 Anthropic 어댑터가 캐시 제외 입력만 보고했다는 점이다.
- `StoredUsage`의 `cachedInputTokens`·`cacheWriteInputTokens`·`reasoningTokens`는 total의 일부다. 별도로 더하는 값이 아니다. `inputTokens`는 캐시 읽기·쓰기를 포함한다.
- `StoredRunStatus`에서 `interrupted`는 사용자를 기다리는 상태다. `running`과 `interrupted`를 뺀 나머지는 종료 상태다.
- assistant 메시지에 `stopReason`(`error`/`aborted`)이 있으면 replay에서 그 메시지와 도구 결과를 뺀다. `source`가 다른 메시지는 다른 모델의 것으로 보고 평문으로 보낸다.
- `StoredInterruptResponse`는 해당 interrupt의 `responseSchema`로 한 번 더 검사된다.
- `migrateTanStackRows`는 `packages/memory-agent/src/db/database.ts`의 `migrateInTransaction` 안에서 호출된다.

## Side Effects

- `migrateTanStackRows` SQLite 읽기: `chat_threads`(`chat_history_projection`과 LEFT JOIN해 `ready` 포함), `btw_threads`, `chat_history_groups`, `chat_metadata`(`modelHandoffNamespace`), `chat_interrupts`, `chat_runs`(usage NOT NULL), `api_usage_responses`(provider='anthropic' 하위 질의).
- `migrateTanStackRows` SQLite 쓰기: 값이 바뀐 행만 `rewrite`로 다시 쓴다.
- `schema.ts`, `metadata.ts`, 그리고 `tanstack-migration.ts`의 순수 변환 함수(`migrateMessage`, `migrateUsage`, `migrateInterruptPayload`)에는 부수 효과가 없다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
