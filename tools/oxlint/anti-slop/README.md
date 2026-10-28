# anti-slop

## Overview
`tools/oxlint/anti-slop`는 저장소 전용 Oxlint JS 플러그인 `anti-slop`의 진입점 디렉터리다. 직속 소스는 `index.ts` 하나이며, `rules/`의 규칙 15개를 `eslintCompatPlugin`으로 묶어 default export한다. 루트 `vite.config.ts`가 `lint.jsPlugins`에 `{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }`로 등록하고, 규칙 15개를 모두 "error"로 켠다. Effect 전용 규칙은 하위 플러그인 `effect/index.ts`(`anti-slop-effect`)로 따로 등록된다.

## Interface
- `antiSlopPlugin` (default export) — `eslintCompatPlugin({ meta: { name: "anti-slop" }, rules })`로 만든 Oxlint 플러그인 객체. 주석상 증거가 약하고 신호가 낮은 구현 패턴을 막는 범용 규칙 모음이다.
- `anti-slop/no-chained-type-assertions` — `noChainedTypeAssertionsRule`(`./rules/no-chained-type-assertions.ts`)에 연결된 규칙 키.
- `anti-slop/no-conditional-empty-object-spread` — `noConditionalEmptyObjectSpreadRule`에 연결된 규칙 키.
- `anti-slop/no-known-value-widening` — `noKnownValueWideningRule`에 연결된 규칙 키.
- `anti-slop/no-module-mocking` — `noModuleMockingRule`에 연결된 규칙 키.
- `anti-slop/no-object-parameters` — `noObjectParametersRule`에 연결된 규칙 키.
- `anti-slop/no-reflect-apply` / `anti-slop/no-reflect-get` — `noReflectApplyRule`, `noReflectGetRule`에 연결된 규칙 키.
- `anti-slop/no-runtime-typeof` — `noRuntimeTypeofRule`에 연결된 규칙 키.
- `anti-slop/no-unsafe-dictionary-type` — `noUnsafeDictionaryTypeRule`(`./rules/no-unsafe-dictionary-type.ts`)에 연결된 규칙 키.
- `anti-slop/no-shape-in-symbol-names` — `./rules/no-shape-in-symbol-names.ts`의 `noForbiddenTermInSymbolNamesRule`에 연결된 규칙 키. 키 이름과 export 이름이 다르다.
- `anti-slop/no-unknown-parameters` / `anti-slop/no-unknown-returns` / `anti-slop/no-unknown-type-aliases` — `noUnknownParametersRule`, `noUnknownReturnsRule`, `noUnknownTypeAliasesRule`에 연결된 규칙 키.
- `anti-slop/no-widen-then-assert` — `noWidenThenAssertRule`에 연결된 규칙 키.
- `anti-slop/require-safety-comment-for-type-assertion` — `requireSafetyCommentForTypeAssertionRule`에 연결된 규칙 키.
- [`effect`](./effect/README.md) — Effect 서비스·Layer 구조를 검사하는 하위 플러그인 `anti-slop-effect`의 진입점.
- [`rules`](./rules/README.md) — `defineRule`로 규칙 하나씩을 export하는 개별 규칙 파일 모음.
- [`shared`](./shared/README.md) — 규칙들이 함께 쓰는 ESTree 분석 도우미 모음.

## Invariants
- 플러그인 이름은 `meta.name: "anti-slop"`이다. 루트 `vite.config.ts`의 규칙 키는 모두 `anti-slop/<규칙>` 접두사를 쓰므로, 이름이나 `rules` 키를 바꾸면 설정도 같이 바꿔야 한다.
- `index.ts`의 `rules` 객체에 새 규칙을 넣어도 자동으로 켜지지 않는다. 루트 `vite.config.ts`의 `lint.rules`에 `anti-slop/<키>`를 따로 추가해야 한다. 현재 등록된 15개는 모두 "error"다.
- 각 규칙은 `./rules/*.ts`에서 `.ts` 확장자를 붙인 상대 경로로 import한다.
- 루트 `vite.config.ts`의 `agentAndVendoredIgnorePatterns`에 `tools/oxlint/anti-slop/**`가 있다. 그래서 플러그인 소스 자체는 lint와 fmt 대상에서 빠진다.
- Effect 서비스·Layer용 규칙은 이 플러그인에 넣지 않는다. 별도 플러그인 `anti-slop-effect`(`./tools/oxlint/anti-slop/effect/index.ts`)로 등록한다.

## Side Effects
- 없음 (순수 함수와 타입만 제공)

## Verification
- Run: `vp lint` (저장소 루트, anti-slop 플러그인을 불러옴)
