# oxlint

## Overview

`tools/oxlint`는 저장소 전용 Oxlint JS 플러그인을 모아 두는 디렉터리다. 이 디렉터리에는 직접 소스 파일이 없고, 하위 디렉터리 `anti-slop`이 플러그인 `anti-slop`의 진입점이다. 루트 `vite.config.ts`가 이 플러그인을 `lint.jsPlugins`에 등록하고 규칙 15개를 모두 `"error"`로 켠다. Effect 전용 규칙은 하위 플러그인 `anti-slop-effect`로 따로 등록된다.

## Subdirectories & Boundaries

- anti-slop: [`./anti-slop/README.md`](./anti-slop/README.md) - `index.ts`가 `rules/`의 규칙 15개를 `eslintCompatPlugin({ meta: { name: "anti-slop" }, rules })`로 묶어 `antiSlopPlugin`으로 default export한다. 증거가 약하고 신호가 낮은 구현 패턴을 막는 범용 규칙 모음이며, 규칙 키는 `anti-slop/no-chained-type-assertions`, `anti-slop/no-conditional-empty-object-spread`, `anti-slop/no-known-value-widening`, `anti-slop/no-module-mocking`, `anti-slop/no-object-parameters`, `anti-slop/no-reflect-apply`, `anti-slop/no-reflect-get`, `anti-slop/no-runtime-typeof` 등이다.
