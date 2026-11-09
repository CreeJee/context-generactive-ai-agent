# allocation

## Overview

`lint/allocation`은 결과에 필요한 것보다 훨씬 많이 할당하는 코드를 잡는 저장소 전용 Oxlint JS 플러그인 `allocation`이다. `index.ts`가 `rules/`의 규칙 세 개를 `eslintCompatPlugin({ meta: { name: "allocation" }, rules })`로 묶어 default export한다. 루트 `vite.config.ts`가 `lint.jsPlugins`에 `{ name: "allocation", specifier: "./lint/allocation/index.ts" }`로 등록하고 세 규칙을 `"warn"`으로 켠다. 가져온 코드인 `anti-slop`과 달리 이 저장소가 직접 쓴 코드라서 lint·fmt 대상이다.

## Interface

- `allocationPlugin` (default export) — 규칙 세 개를 묶은 Oxlint 플러그인 객체.
- `allocation/no-accumulator-copy` — `./rules/no-accumulator-copy.ts`의 `noAccumulatorCopyRule`. `reduce`·`reduceRight`·`runFold`·`runFoldEffect`에 넘긴 reducer 안에서 누적값(또는 그 필드)을 `append`·`appendAll`·`prepend`·`prependAll`·`concat`이나 배열 spread로 복사하면 보고한다. 단계마다 누적값 전체를 복사하면 길이의 제곱만큼 할당하기 때문이다. `Chunk.append`처럼 구조를 공유하는 모듈의 add는 보고하지 않는다.
- `allocation/no-intermediate-array` — `./rules/no-intermediate-array.ts`의 `noIntermediateArrayRule`. `filter`·`map`이 만든 배열을 다음 호출이 한 번 읽고 버리면 보고한다. `filter(p).length`(→ `Array.countBy`), `filter(p)[0]`(→ `find`), 같은 함수를 두 번 잇는 `map().map()`·`filter().filter()`, `some`·`every`·`find`·`findIndex`·`includes`·`indexOf`로 끝나는 체인이 대상이다. `filter`·`map`이 만든 배열을 `new Set`·`new Map`·`new WeakSet`·`new WeakMap`, `Array.from`, `HashSet`·`HashMap`·`MutableHashSet`·`MutableHashMap`·`Chunk`의 `fromIterable`이 한 번 복사하고 버리는 것도 보고한다. 이때는 원소를 하나씩 읽는 `Iterable.filter`·`Iterable.map`을 넘긴다. `Iterable` 모듈의 `filter`·`map`은 지연 계산이라 배열을 만들지 않으므로 보고 대상이 아니다. `map().filter()`도 보고한다. `map`이 버릴 원소까지 변환하기 때문이다. 조건이 원본을 읽으면 `filter`를 먼저 하고, 변환한 값을 봐야 하면 `Array.filterMap`을 쓴다. `filter` 뒤 콜백이 index를 받으면 보고하지 않는다. 그 index는 남은 원소 안의 순서라서 그대로 합칠 수 없다. `filter().map()`은 보고하지 않는다. 남길 원소만 변환하고, 합치려면 원소마다 `Result`나 `[x]`를 새로 만들어야 해서 할당이 줄지 않는다.
- `allocation/prefer-iterable-grouping` — `./rules/prefer-iterable-grouping.ts`의 `preferIterableGroupingRule`. Effect `Array` 모듈의 `groupWith`·`group`·`chunksOf` 호출을 보고한다. 이 함수들은 `chop`으로 조각을 하나 떼어낼 때마다 나머지 배열을 `slice`로 복사해서 조각 수 × 길이만큼 할당한다. 같은 이름의 `Iterable` 함수는 입력을 한 번만 읽는다.

## Invariants

- 플러그인 이름 `"allocation"`은 `vite.config.ts`의 등록 이름, 규칙 키 접두사와 일치해야 한다.
- 세 규칙은 `"warn"`이고, 소스에서 규칙을 끄는 주석을 쓰지 않는다. 크기가 작은 fold도 코드를 고친다. 원소마다 결과를 내면 `Array.mapAccum`으로 결과를 한 번에 만들고, 누적값을 계속 키워야 하면 구조를 공유하는 `Chunk`·`HashMap`·`HashSet`에 담는다.
- 규칙 모듈은 `.ts` 확장자를 붙인 상대 경로로 import한다.

## Side Effects

- 없음 (순수 함수와 타입만 제공)

## Verification

- Run: `vp test lint/allocation` (RuleTester로 세 규칙의 보고 여부 확인)
- Run: `vp lint` (저장소 루트, 플러그인을 불러옴)
