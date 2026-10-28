# scripts

## Overview

`packages/memory-agent/scripts`는 구독형 OAuth 공급자(OpenAI, Anthropic)를 실제 계정으로 한 번씩 검증하는 수동 실행용 Effect CLI 스크립트 모음이다. 각 스크립트는 `packages/memory-agent/src/oauth/validation-harness.ts`의 `createSubscriptionOAuthClient`와 `packages/memory-agent/src/oauth/protocol.ts`의 `providerProtocols`를 사용한다. 브라우저 로그인, refresh, 스트리밍 텍스트, tool call을 차례로 확인하고, 단계마다 `OPENAI_VALIDATION ...`, `ANTHROPIC_VALIDATION ...`, `OPENAI_LOGIN_CHECK ...` 형식의 상태 줄을 출력한다. 결과는 종료 코드로 알린다. `packages/memory-agent/package.json`과 `vite.config.ts`에는 이 파일들을 실행하는 script가 등록되어 있지 않으므로, 직접 실행하는 진단 도구다.

## Interface

- `OAuthCheckReason` — `Schema.TaggedUnion`으로, 일회성 OAuth 점검의 실패 이유를 담는다(`browser_open_failed`, `login_not_connected`, `refresh_not_connected`, `stream_text_missing`, `tool_call_missing`, `cleanup_failed`). 공급자 응답 내용은 담지 않는다. (`oauth-check-failure.ts`)
- `OAuthCheckFailed` — `Schema.TaggedError("OAuthCheckFailed")`이며 `reason: OAuthCheckReason` 필드를 가진다. `message` getter는 reason 태그 이름만 돌려준다. (`oauth-check-failure.ts`)
- `scripts/oauth-live-validation.ts` — CLI 진입점이다. `providerProtocols.openai`로 앱 keychain(`OAuthKeychain`)을 써서 로그인, refresh, 스트리밍 텍스트, `echo_probe` tool call을 검증한 뒤 자격 증명을 지운다. 모델은 `CONTEXT_AGENT_OPENAI_VALIDATION_MODEL` 환경 변수로 정하며 기본값은 `gpt-5.6-sol`이다. 요청 본문은 Responses API 형식이다(`instructions`, `input`, `store: false`).
- `scripts/anthropic-oauth-live-validation.ts` — CLI 진입점이다. `providerProtocols.anthropic`으로 같은 4단계를 검증한다. 모델은 `CONTEXT_AGENT_ANTHROPIC_VALIDATION_MODEL` 환경 변수로 정하며 기본값은 `claude-sonnet-4-6`이다. 요청 본문은 Messages API 형식이다(`system`, `messages`, `tool_choice: {type: "tool"}`). 실패하면 `OAuthHarnessError`의 `status`도 출력한다.
- `scripts/openai-login-check.ts` — CLI 진입점이다. OpenAI 브라우저 로그인만 진단한다. keychain 대신 `Ref` 기반 메모리 `CredentialStore`를 쓰며, 실패하면 `code`/`operation`/`status`를 출력한다.

## Invariants

- `openai-login-check.ts`는 앱의 keychain 자격 증명을 건드리면 안 된다. 그래서 메모리 `Ref` 기반 `CredentialStore`만 쓴다. 근거는 주석 'Never touch the app's keychain credential during a one-off login diagnosis'다.
- live validation 스크립트는 어떤 종료에서든 검증 자격 증명을 지워야 한다(Ctrl+C 포함). 이를 위해 `Effect.ensuring(client.disconnect)`를 쓴다. 정리가 실패하면 `cleanupFailed` Ref를 세우고, 이후 `cleanup_failed` 실패로 종료 코드에 반영한다.
- 로그인 시도(`client.startLogin`)는 `Effect.acquireRelease`로 감싸야 한다. 그래야 어떤 종료에서든 `started.cancel`이 호출되어 callback listener가 닫힌다. 로그인 timeout은 `10 * 60_000`ms다.
- 검증 단계 순서는 고정이다. login, refresh(`client.refreshForValidation`), streaming text, tool call 순서로 진행하고, 단계마다 통과 로그를 출력한 뒤 다음 단계로 간다. 실패한 단계에서 즉시 멈춘다.
- `OAuthCheckReason`/`OAuthCheckFailed`에는 공급자 응답 내용을 넣지 않는다. 실패 메시지는 reason 태그 이름뿐이다(문서 주석 근거).
- `OAuthCheckReason`에 case를 추가하면 `reasonName`의 `OAuthCheckReason.match` 분기도 함께 추가해야 한다.
- 실패는 각 스크립트가 자기 형식으로 이미 출력한다. 그래서 `NodeRuntime.runMain({ disableErrorReporting: true })`로 기본 오류 보고를 끄고 종료 코드로만 알린다.
- Layer 구성: live validation은 `OAuthKeychain.keychain`에 `Layer.provideMerge(nodePlatformLayer)`를 붙여 쓰고, login check는 `nodePlatformLayer`만 쓴다. `Layer.build` 결과를 `Effect.provideContext`로 제공하고 `Effect.scoped`로 감싼다.

## Side Effects

- 네트워크: 실제 OpenAI/Anthropic 구독 OAuth 엔드포인트에 로그인, 토큰 refresh, 스트리밍 요청(`client.stream`)을 보낸다.
- 자식 프로세스: `runProcess({ command: "open", args: [authorizationUrl] })`로 macOS 기본 브라우저를 연다.
- 로컬 callback listener: `client.startLogin`이 로그인 callback을 받으려고 listener를 열고, `cancel`로 닫는다.
- Keychain: live validation 스크립트는 `OAuthKeychain` store에 검증용 자격 증명을 쓰고, 종료할 때 `client.disconnect`로 지운다. `openai-login-check.ts`는 keychain을 쓰지 않는다.
- 환경 변수 읽기: `CONTEXT_AGENT_OPENAI_VALIDATION_MODEL`, `CONTEXT_AGENT_ANTHROPIC_VALIDATION_MODEL` (`Config.String`).
- 콘솔 출력(stdout/stderr) 상태 줄과 프로세스 종료 코드.

## Verification

- Run: `vp run memory-agent#typecheck`
