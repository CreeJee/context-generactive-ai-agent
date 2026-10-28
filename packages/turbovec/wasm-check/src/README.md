# src

## Overview

`packages/turbovec/wasm-check/src`는 `memory-turbovec-wasm-check` 크레이트(`publish = false`)의 유일한 소스다. 런타임 로직이 없는 컴파일 전용 프로브다. 상위 `turbovec` 크레이트(git rev 고정)가 wasm 대상으로 빌드되는지 확인하려고 `turbovec::IdMapIndex`를 다시 내보낸다. 상위 `Cargo.toml`이 `getrandom` 0.2의 `js` 기능을 켜서 wasm에서 JS 엔트로피 브리지를 쓰게 한다. 이전 POC의 네이티브 모듈인 turbovec 패키지의 wasm 호환성을 점검하는 보조 크레이트다.

## Interface

- `IdMapIndex` — `turbovec::IdMapIndex`를 그대로 다시 내보내는 `pub use`이며, 컴파일 확인용으로만 쓰인다
- 하위 디렉터리 없음

## Invariants

- 주석 기준으로 이 프로브는 컴파일 전용이다. 런타임 코드나 테스트를 넣지 않는다.
- 주석 기준으로 JS 엔트로피 브리지는 상위 크레이트의 안전 검사를 우회하지 않고 켠다. 이 브리지는 상위 `Cargo.toml`의 `getrandom = { version = "0.2", features = ["js"] }`다. cfg 우회나 패치로 바꾸지 않는다.
- `turbovec` 의존성은 git rev `ccab9f325e6ce2a270a87daf01ae4e443bcf2d49`로 고정되어 있다. 프로브가 확인하는 대상은 그 리비전의 `IdMapIndex`다.

## Side Effects

- 없음 (순수 함수와 타입만 제공)

## Verification

- Run: `cargo check` (`packages/turbovec/wasm-check`에서)
