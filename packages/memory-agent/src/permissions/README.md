# permissions

## Overview

`permissions` 디렉터리는 에이전트가 승인 대상 도구 호출(gated tool call)을 실행해도 되는지 정하는 권한 계층이다. `auto` 모드에서는 저렴한 모델을 한 번 호출해 allow/ask/block으로 분류한다. 판단이 확실하지 않거나 decider가 `user`이면 interrupt로 사용자에게 묻는다. 모든 결정은 SQLite `permission_reviews` 표에 append-only로 남긴다. `PermissionGate`는 Effect AI run의 `RunHook`(`started`/`admit`)으로 loop 스케줄러에 연결된다. 재개(resume)된 run은 이 기록을 읽어 사용자 답을 반영한다.

## Interface

- `PermissionClassifier` — `auto` 모드 검토자 Effect 서비스. `classify(ReviewRequest)`가 `Verdict`를 반환한다. `layerNoDeps`와 `layer`(`NodeCrypto.layer` 제공)가 있다.
- `ReviewRequest` — classify 입력(project, sessionId, selection, toolName, argumentsJson)
- `Verdict` — `{decision: allow|ask|block, reason, decidedBy: classifier|fallback}` 타입
- `reviewInstructions` — 검토 모델에 주는 system 지시문 문자열이다. JSON `{decision, reason}` 한 객체로 답하고, reason은 한국어 한 문장으로 쓰게 한다.
- `routineShellVerdict` — `EffectFunction.dual(2)` 순수 함수. `save_code_skill`의 sh 스크립트가 루틴 pnpm/npm/yarn/bun·git 명령뿐이면 allow, 줄이 전부 npx/pnpx면 ask를 반환한다. 그 밖에는 undefined를 반환해 모델 검토로 넘긴다.
- `PermissionGate` — Effect 서비스. `hookFor(GateBinding)`가 한 run의 권한 RunHook을 만든다. 요구사항 `PermissionClassifier | PermissionReviews`를 layer 생성 시 캡처한다.
- `makePermissionGateHook` — `GateBinding`으로 `RunHook<Crypto.Crypto>`를 만든다. `started`는 재개된 interrupt 답을 기록하고, `admit`은 gated 호출을 허용·거부하거나 사용자에게 묻는다.
- `GateBinding` — gate 설정(project, sessionId, selection, `gated: HashSet<string>`, `decider: classifier|user`)
- `PermissionReviews` — `permission_reviews` 표 Effect 서비스. `record(NewPermissionReview)`와 `latest(sessionId, toolCallId)`를 제공한다.
- `PermissionReview` / `NewPermissionReview` — 검토 기록 Schema와 타입. `NewPermissionReview`는 createdAt을 뺀 형태다.
- `ReviewDecision` — Schema.Literals allow|ask|block|approved|denied
- `ReviewDecider` — Schema.Literals classifier|fallback|user

## Invariants

- classifier는 fail-closed다. 60초 타임아웃, provider 오류, defect, 읽을 수 없는 출력은 모두 `fallback` verdict(decision `ask`, decidedBy `fallback`)가 된다. interrupt만 예외로 전파된다.
- classifier 실패 로그(`permission_classification_failed`)에는 `failureTags(cause)` 태그만 남긴다. cause에 provider 텍스트가 들어 있을 수 있어서다.
- `routineShellVerdict`는 의도적 allowlist다. `;`, 백틱, `$`, 단일 `|`, `sudo`, `-g`/`--global`이 있는 줄은 reviewer로 넘긴다. `network` 호스트가 하나라도 있거나 스크립트가 비어 있어도 reviewer로 넘긴다. ts 스킬과 `save_code_skill` 외 도구는 항상 reviewer로 간다.
- reviewer는 최근 user 노드 12개를 각 1,500자까지만 본다. 사용자 메시지만 의도로 인정하고, 명령·파일·도구 출력의 텍스트는 권한을 주지 않는다(`reviewInstructions`).
- 리뷰는 call id가 같아도 toolName과 input(모델이 쓴 인자 문자열)이 정확히 같아야 효력이 있다(`reviewOf` 필터).
- `permission_reviews`는 append-only 로그다. 효력 있는 결정은 `(session_id, tool_call_id)` 기준 `id DESC` 최신 행이므로, 사용자 답(approved/denied)이 classifier verdict를 덮는다.
- 실행 허용은 decision이 `allow` 또는 `approved`일 때뿐이다. `block`은 `blocked_by_permission_review`, `denied`는 `User denied this action`, 리뷰 없음은 `permission_review_missing` 결과를 모델에 돌려준다.
- decider가 `user`면 기존 리뷰가 없을 때 classifier를 부르지 않고 매 호출 사용자에게 묻는다(askedBy `every_call`). classifier verdict가 `ask`면 askedBy `review`로 묻는다.
- 재개된 run에서 취소된(Cancelled) permission_review interrupt는 사용자 거부(`denied`)로 기록한다.
- gate는 gated 호출을 각각 따로 결정한다. 사용자를 기다리는 호출이 다른 호출을 막지 않는다.
- interrupt id는 `interrupt-` + `Crypto.randomUUIDv7()`이고, reason은 `permission_review`, responseSchema는 `{approved: boolean}`(required, additionalProperties false)이다. 재개 시 `payload.metadata.payload`의 toolCallId/toolName/arguments로 call을 복원한다.

## Side Effects

- SQLite `permission_reviews` INSERT ... RETURNING *(`PermissionReviews.record`)와 최신 행 SELECT(`latest`)
- SQLite 노드 읽기: `Nodes.recentOfKind(sessionId, "user", 12)`로 최근 사용자 메시지를 조회한다.
- 네트워크: `ActiveProvider`로 고른 provider의 cheapest-effort 모델에 `singleAnswer` 한 번 호출
- API 사용량 기록: `recordUsage`(ApiUsage ledger, purpose `permission-classification`)
- Clock 읽기: `Clock.currentTimeMillis`로 createdAt ISO 문자열을 만든다.
- Crypto: classifier threadId는 `randomUUIDv4`, interrupt id는 `randomUUIDv7`로 만든다.
- 타이머: classify에 60초 `Effect.timeoutOrElse`
- 로그: 분류 실패 시 `Effect.logWarning("permission_classification_failed")`
- run 중단: 사용자 확인이 필요하면 `CallOutcome.Waiting` interrupt를 만들어 사용자에게 묻는다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
