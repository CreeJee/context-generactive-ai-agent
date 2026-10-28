# media

## Overview

`apps/agent/app/entry/media`는 채팅 프런트엔드(entry 앱)에서 이미지 생성 요청을 맡는 React 훅과 승인 대화상자를 둔다. 서버가 `image_approval_required`/`cross_provider` 오류로 OpenAI 이미지 실행 승인을 요구하면, overlay-kit 대화상자로 취소, 이번만 허용, 항상 허용 중 하나를 고르게 한다. 고른 결과에 따라 같은 프롬프트로 다시 요청한다. 이미지 설정 조회와 동의 저장은 `apps/agent/app/entry/queries`의 TanStack Query 훅에 맡긴다. Effect 파이프라인은 `apps/agent/app/entry/shared/ui-effect`의 `runUiEffect`/`uiPromise`로 Promise 경계에서 실행한다.

## Interface

- `ApprovalChoice` — `Data.TaggedEnum` 타입이자 생성자. 변형은 `cancel`, `once { approval: CrossProviderMediaRunApproval }`, `always`이고 `$match`로 분기한다.
- `chooseCrossProviderApproval(approval)` — `overlay.openAsync<ApprovalChoice>`로 'OpenAI 이미지 실행을 허용할까요?' 대화상자를 열고, 사용자가 고른 `ApprovalChoice`로 resolve되는 Promise를 돌려준다.
- `useImageGeneration(onProblem)` — 이미지 생성 React 훅. 반환값은 `{ intent, clearIntent, toggleIntent, settings, generating, asset, generate }`이다.
- `useImageGeneration().generate(prompt)` — 생성을 실행하고 `Promise<boolean>`을 돌려준다. 이미 진행 중이면 `false`, 취소(null 결과)면 `false`, 실패하면 `onProblem`을 부르고 `false`를 돌려준다.
- `useImageGeneration().asset` — 진행 중이면 `null`이고, 끝나면 `generation.data ?? null`이다.
- `useImageGeneration().settings` — `useImageSettingsQuery().data ?? null`이다. 설정 스냅샷의 소유자는 쿼리 캐시이다.
- `useImageGeneration().intent`/`clearIntent`/`toggleIntent` — `react-simplikit`의 `useBooleanState(false)`로 만든 이미지 생성 의도 토글이다.

## Invariants

- 승인 재시도는 다음 조건을 모두 만족할 때만 일어난다: `isApiError(failure)`가 참이고, `failure.code === "image_approval_required"`, `failure.reason === "cross_provider"`, `approval !== undefined`이다. 하나라도 어긋나면 원래 `UnknownError`(`rejected`)를 그대로 다시 실패시킨다.
- 대화상자가 닫히면(`onOpenChange(false)`) 반드시 `ApprovalChoice.cancel()`로 처리한다. 선택 결과는 항상 `close(choice)` 다음 `unmount()` 순서로 확정한다.
- `once`는 서버가 준 approval을 세 번째 인자로 넘겨 `api.generateImage(prompt, true, chosen)`를 다시 호출한다. 영구 동의는 저장하지 않는다.
- `always`는 먼저 `consentMutation.mutateAsync("always")`로 동의를 저장한다. 그 뒤(`Effect.andThen`) approval 없이 `api.generateImage(prompt, true)`를 다시 호출한다. 이 순서를 지켜야 한다.
- `cancel`은 `null`로 성공한다. `generate`는 `null` 결과를 실패가 아닌 `false`로 본다.
- `generation.isPending`이면 `generate`가 요청 없이 `false`를 돌려준다. 같은 훅 인스턴스에서 생성 요청은 동시에 하나만 진행된다.
- 주석 규칙: mutationFn과 generate는 네이티브 SDK 호출자를 위한 Promise/async-iterator 경계이다. 도메인 Effect는 호출자 런타임에서 실행한다(`runUiEffect`).
- 주석 규칙: 이미지 요청과 동의는 하나의 사용자 동작이다. 설정 스냅샷은 쿼리 캐시가 소유한다.
- 모든 `api.generateImage` 호출은 두 번째 인자로 `true`를 넘긴다.

## Side Effects

- 네트워크: `api.generateImage(prompt, true[, approval])` 호출. 첫 요청에 더해 승인 뒤 재요청이 최대 1회 있다.
- 서버 상태 변경: `useCrossProviderConsentMutation().mutateAsync("always")`로 cross-provider 동의를 '항상 허용'으로 저장한다.
- UI/DOM: `overlay.openAsync`로 Dialog를 마운트하고, 선택 뒤 `close`/`unmount`로 정리한다.
- React Query 상태: `useMutation`의 pending/data 상태와 `useImageSettingsQuery` 캐시를 읽는다.
- 콜백: 생성 실패 시 `onProblem("이미지를 생성하지 못했어요. 설정과 계정 권한을 확인해 주세요.")`를 호출한다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
