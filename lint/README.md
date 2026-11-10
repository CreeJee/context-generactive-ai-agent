# lint

## Overview

`lint`는 이 저장소의 커스텀 린트 규칙을 두는 디렉터리다. 직접 소스는 없고, 하위 디렉터리 `anti-slop`이 Oxlint JS 플러그인 `anti-slop`과 하위 플러그인 `anti-slop-effect`를 담는다. 루트 `vite.config.ts`가 두 플러그인을 `lint.jsPlugins`에 `./lint/anti-slop/index.ts`, `./lint/anti-slop/effect/index.ts`로 등록하고 규칙을 모두 `"error"`로 켠다. 가져온 코드라 `agentAndVendoredIgnorePatterns`의 `lint/anti-slop/**`로 lint·fmt 대상에서 빠지고, 저장소의 반복·분기 기준도 적용하지 않는다(`docs/decisions.md`). 하위 디렉터리 `allocation`은 이 저장소가 직접 쓴 플러그인 `allocation`이라 lint·fmt 대상이고, 규칙을 `"warn"`으로 켠다. 하위 디렉터리 `wording`은 한국어 문구 정책을 한곳에 모은다. 플러그인 `wording`(문구를 어디에 두는지)과 Kiwi 문구 검사 CLI(무엇을 말하는지)가 같은 `policy.ts`를 읽는다. `tools`는 개발 도구만 두며 린트 규칙과 문구 검사는 이곳에 둔다.

## Subdirectories & Boundaries

- anti-slop: [`./anti-slop/README.md`](./anti-slop/README.md) - `index.ts`가 `rules/`의 규칙 15개를 `eslintCompatPlugin({ meta: { name: "anti-slop" }, rules })`로 묶어 default export한다. 증거가 약하고 신호가 낮은 구현 패턴(타입 단언 남용, 넓은 타입, 런타임 `typeof`, `Reflect.apply`/`Reflect.get`, 모듈 mocking 등)을 막는다. Effect 서비스·Layer 구조용 규칙은 하위 플러그인 `effect/index.ts`(`anti-slop-effect`)로 따로 등록한다.
- allocation: [`./allocation/README.md`](./allocation/README.md) - 결과에 필요한 것보다 훨씬 많이 할당하는 코드를 잡는 규칙 3개(`no-accumulator-copy`, `no-intermediate-array`, `prefer-iterable-grouping`)를 묶는다. fold 단계마다 누적값을 복사하는 코드, 한 번 읽고 버릴 배열을 `filter`·`map`으로 만드는 체인, 조각마다 나머지 배열을 복사하는 Effect `Array.groupWith`·`group`·`chunksOf`를 보고한다.
- wording: [`./wording/README.md`](./wording/README.md) - 한국어 문구 정책(`policy.ts`)과, Lingui 카탈로그의 메시지를 금지 표현·용어집·말투로 검사하는 CLI(`check/`). 문구를 메시지 안에 두는 lint는 공식 `eslint-plugin-lingui`가 이 정책의 범위로 맡는다.
