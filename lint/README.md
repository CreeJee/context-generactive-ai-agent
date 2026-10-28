# lint

## Overview

`lint`는 이 저장소의 커스텀 린트 규칙을 두는 디렉터리다. 직접 소스는 없고, 하위 디렉터리 `anti-slop`이 Oxlint JS 플러그인 `anti-slop`과 하위 플러그인 `anti-slop-effect`를 담는다. 루트 `vite.config.ts`가 두 플러그인을 `lint.jsPlugins`에 `./lint/anti-slop/index.ts`, `./lint/anti-slop/effect/index.ts`로 등록하고 규칙을 모두 `"error"`로 켠다. 가져온 코드라 `agentAndVendoredIgnorePatterns`의 `lint/anti-slop/**`로 lint·fmt 대상에서 빠지고, 저장소의 반복·분기 기준도 적용하지 않는다(`docs/decisions.md`). `tools`는 개발 도구만 두며 린트 규칙은 이곳에 둔다.

## Subdirectories & Boundaries

- anti-slop: [`./anti-slop/README.md`](./anti-slop/README.md) - `index.ts`가 `rules/`의 규칙 15개를 `eslintCompatPlugin({ meta: { name: "anti-slop" }, rules })`로 묶어 default export한다. 증거가 약하고 신호가 낮은 구현 패턴(타입 단언 남용, 넓은 타입, 런타임 `typeof`, `Reflect.apply`/`Reflect.get`, 모듈 mocking 등)을 막는다. Effect 서비스·Layer 구조용 규칙은 하위 플러그인 `effect/index.ts`(`anti-slop-effect`)로 따로 등록한다.
