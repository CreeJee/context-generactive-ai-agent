# 서버 백엔드: Effect-First

이 디렉터리의 서버·개발 백엔드·생명주기 코드는 현재와 이후의 구현·수리·리팩터링에서도 Effect다운 설계와 코드 스타일을 기본으로 한다. 상위 `AGENTS.md`의 서버 측 규칙을 함께 따른다.

- 서비스와 의존성은 `Context`와 `Layer`로 구성하고 내부 실행 흐름은 Effect로 합성한다.
- 예상 가능한 실패는 타입이 명시된 오류로 모델링하고 외부 입력·프로세스 및 worker 메시지는 경계에서 `Schema`로 검증한다.
- 서버·worker·MessagePort·파일/저장소 lease·callback listener 등 자원은 `Scope`와 `acquireRelease`로 관리한다. 실제 종료 및 중앙 영속 기록의 안전성을 확인하기 전에 lease를 해제하지 않는다.
- 동시 실행·취소·중단·대기는 Fiber와 interruption으로 모델링한다. 외부 부작용의 결과가 미확정이면 자동 재실행하지 않는다.
- Promise·콜백·Node API·서드파티 SDK는 필요한 좁은 경계에서 변환한다. 독립적인 Promise·수동 정리·타이머 흐름을 새 내부 설계로 확장하지 않는다.
- 명령형 비즈니스 로직을 겉으로만 `Effect.sync`/`Effect.tryPromise`로 감싸는 것으로 전환을 완료했다고 간주하지 않는다.
- 순수 계산은 순수 함수로 유지할 수 있다. 낮은 수준의 경계 코드와 남은 미전환 범위를 검토·검증 근거에 명시한다.
- Effect 작성 전 설치된 `node_modules/effect/AGENTS.md`를 전체 읽고 관련 링크를 따른다. 문서에 없는 API는 설치된 `node_modules/effect/src`에서 확인한다.
- Effect 전환을 이유로 owner lock, build-ID/인가 gate, Goal/run 세대 고정, OAuth callback 소유권 또는 미확정 부작용 보호를 제거하지 않는다. 정상·실패·취소·정리 경로를 실제 테스트로 확인한다.
