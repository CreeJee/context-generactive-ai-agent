# 프로젝트 목표

세션이 달라져도 모든 맥락을 기억하는 메모리 모듈을 만듭니다.

## Used Libraries

- Security: @secretlint/*
- AI: @tanstack/ai-*
- logic flow: effect

## Effect 지침

현재 작업뿐 아니라 이후의 에이전트 백엔드 구현·수리·리팩터링에도 Effect다운 설계와 코드 스타일을 적용한다.

- 서비스와 의존성은 `Context`와 `Layer`로 구성하고 내부 실행 흐름은 Effect로 합성한다.
- 예상 가능한 실패는 타입이 명시된 오류로 모델링하고 외부 입력은 경계에서 `Schema`로 검증한다. `left`/`right`를 직접 확인하는 대신 Effect의 합성·오류 처리 API를 사용한다.
- 자원 획득·해제는 `Scope`와 `acquireRelease`로 관리하고 동시 실행·취소·중단은 Fiber와 interruption으로 처리한다.
- Promise·콜백·Node API·서드파티 SDK는 좁은 상호운용 경계에서 변환한다. 내부 로직에 독립적인 Promise·수동 정리·타이머 흐름을 늘리지 않는다.
- 명령형 비즈니스 로직을 겉으로만 `Effect.sync`/`Effect.tryPromise`로 감싸는 것으로 전환을 완료했다고 간주하지 않는다. 의존성·실패·취소·자원 수명을 실제로 Effect로 모델링한다.
- 부수 효과가 없는 계산은 순수 함수로 둘 수 있다. SDK/런타임에 필요한 낮은 수준의 경계 코드는 좁게 유지하고 근거를 명시한다.
- 새 코드와 변경 코드의 검토·검증에서 적용 범위와 남은 위반을 확인한다. 기존 보호 장치나 실행 중인 작업을 제거하는 구실로 삼지 않는다.
- Effect 코드를 작성하기 전에 설치된 `node_modules/effect/AGENTS.md`를 전체 읽고 관련 링크를 따른다. 그 문서에 없는 API는 설치된 `node_modules/effect/src`에서 확인한다.

Effect 가이드문서: 설치된 `node_modules/effect/AGENTS.md`와 그 문서에서 연결하는 예시·소스. 다른 버전의 외부 가이드를 현재 설치본의 API 근거로 사용하지 않는다.
