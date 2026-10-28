# src

## Overview

`packages/utils/src`는 tsdown/Vite+ 스타터 템플릿에서 생성된 뒤 실제 내용이 채워지지 않은 유틸리티 패키지의 소스 디렉터리다. 유일한 파일 `index.ts`는 고정 문자열을 반환하는 예제 함수 `fn` 하나만 export한다. `package.json`은 `vp pack` 빌드 결과물 `./dist/index.mjs`를 패키지 진입점으로 export하며, 설명·작성자·저장소 필드도 템플릿 기본값 그대로다. 현재 시스템의 다른 코드가 이 패키지에 의존한다는 증거는 이 디렉터리 안에서 확인되지 않는다.

## Interface

- `fn` — 인자 없이 문자열 "Hello, tsdown!"을 반환하는 템플릿 예제 함수 (`index.ts`에서 export)
- 하위 디렉터리 없음

## Invariants

- 패키지 공개 진입점은 `package.json`의 `exports["."]` = `./dist/index.mjs`이다. 따라서 `src/index.ts`의 export가 `vp pack` 빌드를 거쳐야 소비자에게 노출된다.

## Side Effects

- 없음 (순수 함수와 타입만 제공)

## Verification

- Run: `vp run utils#typecheck`
- Run: `vp run utils#test`
