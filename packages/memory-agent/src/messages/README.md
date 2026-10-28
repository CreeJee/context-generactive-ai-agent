# messages

## Overview

`packages/memory-agent/src/messages`는 채팅 메시지 형태를 판별하는 작은 순수 헬퍼를 두는 디렉터리다. 현재 `empty-user.ts` 한 파일만 있다. `isEmptyUserText`는 버려도 되는 빈 사용자 텍스트 메시지인지 판별한다. `loop/store.ts`, `btw/store.ts`, `agent/compaction.ts`는 이 헬퍼로 저장·압축 전에 빈 메시지를 거른다. `btw/chat.ts`는 빈 질문을 `empty_message`로 거절할 때, `agent/chat.ts`는 마지막 메시지가 빈 사용자 텍스트인지 확인할 때 이 헬퍼를 쓴다.

## Interface

- `isEmptyUserText(message: { readonly role: string; readonly content?: unknown }): boolean` — `role === "user"`이고 `content === ""`이며 객체 키가 모두 `id`, `role`, `content`, `createdAt`, `metadata` 안에 있을 때만 true를 돌려준다

## Invariants

- 확정된 빈 텍스트 형태만 버릴 수 있다. 미디어 payload와 알 수 없는 payload는 보존해야 한다. 그래서 허용 키 집합 `textMessageFields`(`id`, `role`, `content`, `createdAt`, `metadata`) 밖의 키가 하나라도 있으면 false를 돌려준다.
- `content`는 정확히 빈 문자열 `""`이어야 한다. 공백 문자열, `undefined`, 배열 content는 빈 메시지로 보지 않는다.
- `role`이 `user`인 메시지만 대상이다. assistant, system 같은 다른 role은 항상 보존한다.
- 허용 키 집합을 넓히면 호출처 다섯 곳의 필터링·거절 동작이 함께 바뀐다. 해당 호출처는 `loop/store.ts`, `btw/store.ts`, `btw/chat.ts`, `agent/compaction.ts`, `agent/chat.ts`다.

## Side Effects

- 없음 (순수 함수와 타입만 제공)

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
