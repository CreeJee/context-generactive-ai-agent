# 프로젝트 목표

세션이 달라져도 모든 맥락을 기억하는 에이전트를 만듭니다.

## Used Libraries

- UI & style: tailwind, cn, cva, shadcn
- AI: @tanstack/ai @tanstack/ai-react @tanstack/ai-openai
- Router: React Router Framework mode

lint와 format은 vite+ 가이드라인을 따르세요.
UI는 shadcn으로만 구현하고, 필요한 컴포넌트는 shadcn mcp로 추가하세요.

## 서버 측 코드: Effect-First

API route의 loader/action, 서버 런타임 연결 및 개발·패키징 scripts 등 서버 측 코드는 현재와 이후의 구현·수리·리팩터링에서도 Effect 기반으로 작성한다. 이 규칙은 React UI 구현에 적용하지 않는다.

- 서비스·의존성은 `Context`/`Layer`, 타입 오류·입력 검증은 Effect 오류 모델/`Schema`, 자원 수명은 `Scope`/`acquireRelease`, 동시성·취소는 Fiber/interruption으로 모델링한다.
- React Router·Node·SDK의 Promise/콜백 인터페이스는 경계에서만 변환한다. 명령형 내부 로직을 겉으로만 Effect로 감싸거나 수동 정리·타이머 흐름을 늘리지 않는다.
- 순수 계산은 순수 함수로 유지할 수 있다. 낮은 수준의 상호운용 경계와 남은 미전환 범위는 검토 근거에 명시하고 기존 안전 gate를 유지한다.
- Effect 작성 전 설치된 `node_modules/effect/AGENTS.md`를 전체 읽고, 관련 링크와 필요한 `node_modules/effect/src` API를 확인한다.
- `server/` 내부의 구체적인 적용 지침은 `server/AGENTS.md`를 따른다.
