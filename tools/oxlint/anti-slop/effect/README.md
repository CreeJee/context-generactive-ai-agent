# effect

## Overview
이 디렉터리는 저장소 전용 Oxlint anti-slop 플러그인 중 Effect 서비스·Layer 구조를 검사하는 하위 플러그인 `anti-slop-effect`의 진입점이다. `index.ts`는 `vite-plus/lint/plugins`의 `eslintCompatPlugin`으로 `rules/` 하위 규칙을 묶어 default export한다. 루트 `vite.config.ts`가 이 파일을 `./tools/oxlint/anti-slop/effect/index.ts` specifier로 `anti-slop-effect` 이름에 등록하고, `anti-slop-effect/no-service-constructor-imports` 규칙을 `"error"`로 켠다.

## Interface
- `antiSlopEffectPlugin` (default export) — `eslintCompatPlugin({ meta: { name: "anti-slop-effect" }, rules })`로 만든 Oxlint 플러그인 객체. 주석상 Effect 서비스·Layer 구조용 opt-in 규칙 모음이다.
- `anti-slop-effect/no-service-constructor-imports` — 플러그인이 노출하는 규칙 키. 구현은 `./rules/no-service-constructor-imports.ts`의 `noServiceConstructorImportsRule`이다. 상대 경로 모듈의 `make<대문자>` 서비스 생성자 import를 막는다.
- [`rules`](./rules/README.md) — Effect 계열 규칙 구현. `noServiceConstructorImportsRule`을 제공한다.

## Invariants
- 플러그인 `meta.name`인 `"anti-slop-effect"`는 `vite.config.ts`의 플러그인 등록 이름, 규칙 키 접두사, 소스의 `// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports` 주석과 일치해야 한다. 바꾸면 설정과 disable 주석이 함께 깨진다.
- 규칙 키 `"no-service-constructor-imports"`는 `vite.config.ts`의 `"anti-slop-effect/no-service-constructor-imports": "error"` 설정과 `packages/memory-agent`의 disable 주석이 참조한다.
- 주석상 플러그인은 opt-in이다. 규칙은 `vite.config.ts`에서 명시적으로 켤 때만 적용된다.
- 플러그인은 `vite-plus/lint/plugins`의 `eslintCompatPlugin` 형식을 따라야 한다. 규칙 모듈은 `.ts` 확장자를 붙인 상대 경로로 import한다.

## Side Effects
- 없음 (순수 함수와 타입만 제공)

## Verification
- Run: `vp lint` (저장소 루트, anti-slop 플러그인을 불러옴)
